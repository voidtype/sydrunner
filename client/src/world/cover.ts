/**
 * Ground cover: the one table the pipeline, the near field and the horizon all
 * read, and the reason the hills stopped being brown.
 *
 * ---------------------------------------------------------------------------
 * ## What was actually wrong, because the obvious answer was wrong
 *
 * The report was a bare brown hillside in Lane Cove National Park, and it had
 * two independent causes with one appearance.
 *
 * The near half was data: `sources.osm`'s green read looked at nine tag values
 * and not one of them was a bushland tag, so 2,917 km2 of the world -- every
 * national park, reserve, scrub, heath and mangrove reach in Greater Sydney --
 * was drawn as the same dry buff dirt as a car park and scattered with no trees
 * at all. `pipeline/sydney/vegetation.py`'s header is that story and this file
 * is not it.
 *
 * The far half is this file. Past the streaming radius there is no tile, no
 * surface slot and no instance: the horizon is `far-terrain.bin`, a coarse
 * heightfield at 500 m posts wearing `ground.ts`'s dirt material, and that
 * material has never had any idea what grows on it. So even after the near
 * field is fixed, Ku-ring-gai is green for 1.8 km and brown for the next
 * eighteen -- which is a *worse* frame than the one being fixed, because now
 * there is a line across the landscape where the colour changes.
 *
 * `far.ts`'s `FAR_TINT` was named as the cause of this and is not. That table
 * is indexed by a **building's wall material** and `far.bin` holds nothing but
 * buildings, so its `park_grass` row -- grey-brown, and correctly noted there as
 * a filler -- has never been read by anything at all. It still needs a row per
 * slot, because the file throws at import if the table is shorter than
 * `MATERIALS`, and the two new ground slots have one each.
 *
 * ---------------------------------------------------------------------------
 * ## `far-cover.bin`: one byte per quarter square kilometre
 *
 * A u8 per far-terrain post, in the same row-major, north-first order as
 * `far-terrain.bin` itself, so the two are read with one index:
 *
 *     bits 7..5   the cover class, 0..6, `COVER_NONE` first
 *     bits 4..0   how much of that 500 m cell the class covers, 0..31
 *
 * 59 kB for the whole 60 km world -- 243 x 243 posts -- against
 * `far-terrain.bin`'s 236 kB, and it is fetched beside it and never evicted.
 *
 * What that byte buys, measured over the shipped extent by `sydney far-cover`:
 *
 *     forest   12,702 posts   3,176 km2   21.5% of the horizon
 *     mown      4,503           1,126      7.6%
 *     rough       858             214      1.5%
 *     wetland     217              54      0.4%
 *     scrub       209              52      0.4%
 *     heath        23               6      0.0%
 *     nothing  40,537          10,134     68.6%   sea, and the ground OSM has
 *                                                 said nothing about
 *
 * **31.4% of the far field stops being dirt**, which is the half of the
 * screenshot the near field cannot reach at any density.
 * The class alone would have been 3 bits and a fifth of a byte wasted; the
 * coverage fraction is what the other five buy, and it is what keeps a ridge
 * that is half cleared from reading as solid forest and a suburb with a golf
 * course in it from reading as a paddock.
 *
 * **Colour only. Impostors are refused and the refusal is the point.** At two
 * kilometres an individual crown subtends well under an arcminute; what the eye
 * reads on a forested ridge is the tone and the way the tone follows the
 * terrain, and both of those are exactly what a per-post colour gives. An
 * impostor clump would buy silhouette at the ridge line -- real, and
 * second-order -- for a new payload, a new per-hex slice, a new eviction rule
 * and a new draw call, and it belongs in the same round as the near-field
 * impostor that `world/vegetation.ts` has been holding a seam open for.
 *
 * No `three` import: this file is read by `server/index.ts` as well, which is
 * what lets `verifyCanopy` run in both boot lists.
 */

/** Cover classes, in the order the pipeline's `vegetation.COVER_CODE` numbers them. */
export const COVER_NONE = 0;
export const COVER_MOWN = 1;

/** Names, for the debug overlay and for the self-check's messages. */
export const COVER_NAME = [
  'none',
  'mown',
  'rough',
  'forest',
  'scrub',
  'heath',
  'wetland',
] as const;

/** Seven classes in three bits, and the packing depends on it. */
export const COVER_COUNT = COVER_NAME.length;

/** The coverage fraction's resolution: five bits, so 0..31 maps to 0..1. */
export const COVER_STEPS = 31;

type Rgb = [number, number, number];

/**
 * What a cover class looks like from two kilometres, as a **linear** albedo for
 * the standard rig -- these go into the far ground's `colorNode` and are shaded,
 * unlike `far.ts`'s slab tints which are already-lit values.
 *
 * Every one is stated with the display value it renders to at the reference
 * instant, and every one of them is calibrated against two things that are
 * already in the world rather than chosen: `ground.ts`'s dirt renders at
 * rgb(194, 176, 144) and rgb(172, 155, 109), and `vegetation.ts`'s park grass at
 * rgb(168, 169, 121) and rgb(137, 151, 97). A cover tint that does not sit
 * clearly under and greener than the first pair has not fixed anything.
 *
 * The other rule is `ground.ts`'s, restated because it applies here hardest of
 * all: **this is February and it is not England.** A forested Sydney ridge at
 * range is grey-olive and dusty, nearer to the dead grass than to anything a
 * nursery would call green, and the temptation to make the national parks
 * emerald is the single fastest way to lose the city.
 */
export const COVER_TINT: readonly Rgb[] = [
  //                                                   -> sun rgb(  -,   -,   -)
  [0.0, 0.0, 0.0], // none -- never mixed; the dirt is left exactly as it is
  //                                                   -> sun rgb(152, 160, 109)
  [0.1183, 0.1285, 0.0633], // mown: the midpoint of the two park-grass tones
  //                                                   -> sun rgb(146, 146, 110)
  [0.1106, 0.1106, 0.0645], // rough: unmown paddock and fairway, half a shade down
  //                                                   -> sun rgb(104, 112,  88)
  [0.057, 0.0672, 0.0365], // forest: the darkest, and the whole point of the file
  //                                                   -> sun rgb(120, 126, 100)
  [0.0774, 0.085, 0.0518], // scrub: lighter than forest, no closed canopy
  //                                                   -> sun rgb(140, 140, 112)
  [0.1029, 0.1029, 0.0672], // heath: sandstone and sedge show through it
  //                                                   -> sun rgb(112, 116, 100)
  [0.0672, 0.0723, 0.0518], // wetland: grey-green, the least saturated of the six
];

/** The class packed into one `far-cover.bin` byte. */
export function coverClass(byte: number): number {
  return (byte >> 5) & 0x07;
}

/** How much of the cell that class covers, 0..1. */
export function coverAmount(byte: number): number {
  return (byte & 0x1f) / COVER_STEPS;
}

/**
 * Pack one post the way the pipeline does. Exported for the self-check, which
 * round-trips it rather than trusting two implementations of a bit shift.
 */
export function packCover(cls: number, steps: number): number {
  return ((cls & 0x07) << 5) | (steps & 0x1f);
}

/**
 * `far-cover.bin` expanded to the vertex attribute the far ground wears:
 * `(r, g, b, amount)` per post as unsigned bytes, ready for a normalized
 * `BufferAttribute`.
 *
 * Bytes rather than floats, and it is 720 kB of the reason: the far ground is
 * (posts + 2)^2 vertices -- 60,025 at 60 km -- and a float32 vec4 on it is
 * 960 kB of buffer to carry a colour that has 31 distinct values in it.
 *
 * `stride` is the mesh's row stride, which is `posts + 2`: the far ground
 * carries one apron ring around the heightfield so that one triangulation loop
 * produces the grid, its four edges and its four corners. The apron gets
 * `COVER_NONE` -- it is the sea and the empty plain past the build, and there
 * is nothing growing on it.
 */
export function expandCover(cover: Uint8Array, posts: number): Uint8Array {
  const stride = posts + 2;
  const out = new Uint8Array(stride * stride * 4);
  for (let r = 1; r <= posts; r++) {
    for (let c = 1; c <= posts; c++) {
      const byte = cover[(r - 1) * posts + (c - 1)];
      const amount = byte & 0x1f;
      if (amount === 0) continue;
      const tint = COVER_TINT[coverClass(byte)] ?? COVER_TINT[COVER_NONE];
      const o = (r * stride + c) * 4;
      // Scaled to the byte range against the brightest channel any tint has, so
      // the quantisation step is ~0.5 display values rather than ~4. The shader
      // multiplies it back out; see `COVER_TINT_SCALE`.
      out[o] = Math.round(Math.min(tint[0] * COVER_TINT_SCALE, 1) * 255);
      out[o + 1] = Math.round(Math.min(tint[1] * COVER_TINT_SCALE, 1) * 255);
      out[o + 2] = Math.round(Math.min(tint[2] * COVER_TINT_SCALE, 1) * 255);
      out[o + 3] = Math.round((amount / COVER_STEPS) * 255);
    }
  }
  return out;
}

/**
 * What the shader multiplies the packed tint back out by. The reciprocal of a
 * round number just over the largest channel in `COVER_TINT` (0.1285), so every
 * tint uses at least 92% of the byte range and none of them clips.
 */
export const COVER_TINT_SCALE = 1 / 0.14;

/**
 * Boot check. Runs in both `client/src/main.ts` and `server/index.ts`, which is
 * what the no-`three` rule at the top of this file buys.
 *
 * Three claims, and each of them is a thing that would otherwise fail silently
 * and late:
 *
 *   - **The packing round-trips.** A class and a coverage step recovered from
 *     the byte are the ones that went in, for every class and at both ends of
 *     the fraction. The pipeline writes these bytes and nothing on the wire
 *     describes them, so a shift changed on one side is a world where every
 *     national park is a golf course.
 *   - **Seven classes still fit in three bits**, and there is a tint for each.
 *     Adding an eighth is legal; a ninth silently aliases onto the first, and
 *     the coverage fraction underneath it goes with it.
 *   - **Every tint is under the dirt it replaces.** The failure this catches is
 *     the one the whole file exists to prevent, and it is a taste failure rather
 *     than a crash: a cover colour brighter than `ground.ts`'s soil does not
 *     make the hills green, it makes them pale, and nothing in the output would
 *     say so.
 */
export function verifyCanopy(): string[] {
  const out: string[] = [];

  for (let cls = 0; cls < COVER_COUNT; cls++) {
    for (const steps of [0, 1, 17, COVER_STEPS]) {
      const b = packCover(cls, steps);
      if (b < 0 || b > 255) out.push(`packCover(${cls}, ${steps}) is ${b}, not a byte`);
      if (coverClass(b) !== cls) {
        out.push(`cover class ${cls} at ${steps}/31 unpacks as ${coverClass(b)}`);
      }
      const want = steps / COVER_STEPS;
      if (Math.abs(coverAmount(b) - want) > 1e-9) {
        out.push(`cover amount ${steps}/31 unpacks as ${coverAmount(b)}, wanted ${want}`);
      }
    }
  }

  if (COVER_COUNT > 8) {
    out.push(`${COVER_COUNT} cover classes will not fit in the 3 bits far-cover.bin gives them`);
  }
  if (COVER_TINT.length !== COVER_COUNT) {
    out.push(`COVER_TINT has ${COVER_TINT.length} rows against ${COVER_COUNT} classes`);
  }

  // The expansion, over a 3 x 3 grid whose nine posts are all different.
  //
  // This is where an off-by-one lives if there is one, and it is the worst kind
  // to have: the apron ring means the attribute is (posts + 2) wide while the
  // file is `posts` wide, so a stride taken from the wrong one paints the world
  // shifted by a growing diagonal offset -- forest on the harbour and water on
  // the ridges -- which looks like bad data rather than like a bug.
  {
    const posts = 3;
    const stride = posts + 2;
    const grid = new Uint8Array(posts * posts);
    for (let i = 0; i < grid.length; i++) {
      grid[i] = packCover(COVER_MOWN + (i % (COVER_COUNT - 1)), 1 + i * 3);
    }
    const attr = expandCover(grid, posts);
    if (attr.length !== stride * stride * 4) {
      out.push(`expandCover made ${attr.length} bytes, wanted ${stride * stride * 4}`);
    }
    // The apron ring is untouched on all four sides.
    for (let k = 0; k < stride; k++) {
      for (const o of [k * 4, ((stride - 1) * stride + k) * 4, k * stride * 4, (k * stride + stride - 1) * 4]) {
        if (attr[o + 3] !== 0) out.push('expandCover wrote cover into the apron ring');
      }
    }
    for (let r = 0; r < posts; r++) {
      for (let c = 0; c < posts; c++) {
        const byte = grid[r * posts + c];
        const o = ((r + 1) * stride + (c + 1)) * 4;
        const want = Math.round(coverAmount(byte) * 255);
        if (attr[o + 3] !== want) {
          out.push(`expandCover put amount ${attr[o + 3]} at (${r},${c}), wanted ${want}`);
        }
        const tint = COVER_TINT[coverClass(byte)];
        const got = attr[o] / 255 / COVER_TINT_SCALE;
        if (Math.abs(got - tint[0]) > 0.002) {
          out.push(
            `expandCover put red ${got.toFixed(4)} at (${r},${c}), wanted ${tint[0].toFixed(4)}`,
          );
        }
      }
    }
  }

  // `ground.ts`'s two soil albedos, restated rather than imported: that module
  // pulls in `three/tsl` and this one may not. Their linear luminances are the
  // bar every cover tint has to sit under.
  const SOIL_LINEAR: Rgb[] = [
    [0.195, 0.152, 0.096],
    [0.153, 0.118, 0.058],
  ];
  const luma = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const brightestSoil = Math.max(...SOIL_LINEAR.map(luma));
  for (let cls = COVER_MOWN; cls < COVER_COUNT; cls++) {
    const y = luma(COVER_TINT[cls]);
    if (y >= brightestSoil) {
      out.push(
        `${COVER_NAME[cls]} cover is lighter than the dirt it replaces ` +
          `(${y.toFixed(4)} against ${brightestSoil.toFixed(4)}); the hills will read pale, not green`,
      );
    }
    if (COVER_TINT[cls][1] <= COVER_TINT[cls][2]) {
      out.push(`${COVER_NAME[cls]} cover has no green over its blue; it is not vegetation`);
    }
  }
  return out;
}
