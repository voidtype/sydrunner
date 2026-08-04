/**
 * The build stamp that makes a one-year cache on the world safe.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM. A first visit downloads about 350 MB of city, tile by tile, as
 * the player walks -- and every byte of it is immutable in practice and mutable
 * in name. `world/tiles/5_-1.glb` is the same file for months and then, on the
 * day the pipeline is re-run, it is a different file **under the same name**.
 * Tiles are not content-addressed: `tiles.py` writes `<tile key>.glb`, and the
 * key is a grid coordinate.
 *
 * So the two obvious answers are both wrong. Serving `/world/*` with a short
 * cache means a returning player re-downloads the city; serving it
 * `immutable, max-age=31536000` means a player who ever loaded the old build
 * gets a mixture of old and new tiles for a year, which is a seam through the
 * middle of the map that no reload can clear.
 *
 * ---------------------------------------------------------------------------
 * THE ANSWER, which is the oldest one in web caching: put the version in the
 * URL. The pipeline stamps `built` -- epoch seconds -- into `index.json` on
 * every run, and every world asset is fetched as `<path>?v=<built>`. A retile
 * moves the stamp, every URL changes, and every cache in the chain misses and
 * re-fetches exactly once. Nothing needs purging, because nothing is being
 * overwritten from the cache's point of view.
 *
 * `index.json` itself is the one file that must **not** carry the parameter and
 * must not be cached hard -- it is what tells the client which version to ask
 * for, so it is the pivot the whole scheme turns on. The Caddy rule in
 * `caddy/world-cache.Caddyfile` says so explicitly rather than by omission.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ABSENT STAMP MEANS. Nothing at all: the suffix is empty and every URL
 * is what it was. A world built before this existed is still a world, and the
 * client's rule everywhere else -- an old index loads, it just does less -- is
 * this one too. The cost of the empty case is that the long cache header is
 * unsafe for that build, which is why the Caddyfile snippet is documented
 * alongside a stamped world rather than as a standalone tweak.
 */

/** The index fields this reads. Structural, so nothing imports the streamer. */
export interface VersionedIndex {
  /** Epoch seconds at which the pipeline wrote the index. See `tiles.write_index`. */
  built?: number;
}

/**
 * The query suffix every world asset URL carries, or `''` for an unstamped
 * build. Appended rather than composed, because no world URL has a query of its
 * own and a `URL` round-trip per tile fetch would be all cost and no meaning.
 */
export function worldVersionSuffix(index: VersionedIndex | null | undefined): string {
  const built = index?.built;
  return typeof built === 'number' && built > 0 ? `?v=${built}` : '';
}
