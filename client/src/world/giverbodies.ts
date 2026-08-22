/**
 * Standing the quest givers up: twelve pooled rigs, and the head the `!` now
 * hangs off.
 *
 * The **rendering** half of `game/giverbodies.ts`, on `world/characters.ts`'s
 * split exactly -- that file decides who a giver is and is compiled into the Bun
 * server; this one draws her and imports three. Read that header first. It
 * carries the design: the appearance is the id, the heading is the street, the
 * pose is the rig's own idle phased per person, and **a giver is not an actor,
 * not on the wire, and not solid**.
 *
 * ---------------------------------------------------------------------------
 * THE FIGURE IS THE FIGURE, AND THIS FILE OWNS NO GEOMETRY AT ALL
 *
 * `world/characters.ts` opens with that rule and this file takes it further than
 * any other user of the rig has: there is not even a prop here. A giver is a
 * `CharacterActor` on one of `CharacterAssets`' seven kit geometries and on
 * `CharacterAssets.material`, and that is the whole of her. No `Parts`, no
 * `build()`, no `dispose()` of anything shared.
 *
 * Which is what makes the cost claim in the brief -- *"it costs what one more
 * pedestrian costs"* -- true rather than aspirational, and it has a second
 * consequence worth stating plainly because somebody will look for it:
 *
 *   **There is no `warmupParts()` on this class, deliberately.**
 *
 * A pipeline is keyed on (material, attribute layout, bone count,
 * `receiveShadow`) and, for the depth pass, on the layout and the bones alone.
 * A giver's rig is the *same material object*, the *same* seventeen-bone
 * skeleton and the *same* attribute layout as the pedestrian rigs, the remote
 * players and the two throwaway characters `main.ts` hands to
 * `warmUpPipelines` whole. Every pipeline this feature will ever draw with is
 * compiled at boot by things that already exist, so a part here would warm a
 * duplicate and `perf-harness --coverage` would report it as warm-without-real.
 * `world/warmup.warmupSignature`'s own dedupe makes the same point from the
 * other side. If a giver ever gets a prop or a bespoke kit geometry, that stops
 * being true and this paragraph is the note saying so.
 *
 * ---------------------------------------------------------------------------
 * TWO CLOCKS, AND THE SECOND ONE IS BORROWED
 *
 * `world/questmarkers.ts` runs the **billboard** every frame and the
 * **decision** at `RESCAN_HZ`, and says why at length. This field has exactly
 * the same shape, and rather than keep a second accumulator that drifts against
 * the first it reads `QuestMarkerField.beats` -- a counter the marker field
 * bumps on each of its own rescans -- and re-decides when the number changes.
 * One clock in the frame, and by construction the two features can never
 * disagree about which beat they are on.
 *
 * The pose runs every frame, because a giver whose turn lagged a quarter of a
 * second would read as broken for exactly the reason a lagging billboard does.
 *
 * ---------------------------------------------------------------------------
 * WHICH WAY THE HEIGHT FLOWS, WHICH IS THE POINT OF THE WHOLE EXERCISE
 *
 * `questmarkers`' header asked for this by name: *"when somebody gives the
 * givers bodies, the height here should come off the rig's head bone the way
 * `main.ts` feeds the plate field."* So `headY(id)` answers with the world y of
 * `BONE.HEAD` for any giver this field is currently drawing, and
 * `QuestMarkerSource.headY` is that function; `game/giverbodies.markYFromHeadBone`
 * adds the crown offset and the clearance, and is arranged so that a giver
 * standing in the bind pose puts the mark at exactly the height the old
 * ground-plus-a-person arithmetic did. A body appearing under an existing mark
 * therefore moves it by nothing.
 *
 * The head is made current with `CharacterActor.refreshHeadMatrix`, which walks
 * *up* six ancestors rather than recomposing the eighteen-node subtree -- the
 * nameplates' own measurement, 5.6 us against 20.35 for fifteen figures, and
 * the same reason applies here.
 *
 * One beat of settle, and it is worth being honest about: the marker field
 * rescans before this field re-decides in the same frame, so on the very first
 * beat a giver is in range her mark uses the ground estimate and from the next
 * beat it uses her head. In the bind pose those two numbers are equal to a
 * millimetre, so what settles is a difference nobody can see.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COSTS
 *
 * Zero when no giver is near: twelve invisible objects in the scene graph, one
 * `selectGivers` over a hundred-and-three-entry array four times a second, and
 * a loop over twelve unheld slots that `continue`s. No instance buffers, no
 * uploads, nothing per frame.
 *
 * Bounded when they are: one draw call and one skeleton per drawn giver, capped
 * at twelve, and measured against the shipped content at **five** anywhere in
 * Sydney (`game/giverbodies.MAX_GIVER_BODIES` has the census). That is the same
 * order as `CharacterCrowd`'s twelve and `PedestrianCrowd`'s fourteen, and it is
 * the cost of one more pedestrian per giver, which is what was asked for.
 */

import { Vector3 } from 'three/webgpu';

import { BONE } from '../player/animation.ts';
import { CharacterActor, type CharacterAssets } from '../player/character.ts';
import {
  FOOTPATH_PROBE_M,
  GIVER_BODY_RANGE_M,
  MAX_GIVER_BODIES,
  TURN_RANGE_SCALE,
  bandHeading,
  createGiverSelection,
  createGiverStance,
  giverHash,
  giverIdlePhase,
  giverKit,
  hashHeading,
  markYFromGround,
  markYFromHeadBone,
  poseGiver,
  selectGivers,
  type GiverSelection,
  type GiverStance,
} from '../game/giverbodies.ts';
import { PEDESTRIAN_KIT_COUNT, buildBands, syntheticGrid, type PedBand } from '../game/pedestrians.ts';
import { parseDialogPack, type DialogNpc } from '../game/questmodel.ts';
import { MARKER_RANGE_M, MAX_MARKERS } from './questmarkers.ts';

/**
 * Everything the field reads, supplied by `main.ts` as closures.
 *
 * `QuestMarkerSource`'s arrangement one file over, and for its reason: this
 * object reaches into nothing, and the one file that knows where the bundle is,
 * how high the ground is and which footpaths are resident is the one that
 * assembles it. Every method is called on the **beat only** -- four times a
 * second -- which is what makes `bandsNear` affordable.
 */
export interface GiverBodySource {
  npcs(): readonly DialogNpc[];
  /** Ground under a point. `main.ts`'s `wildGround`, the same sample the marks use. */
  groundAt(x: number, z: number): number;
  /**
   * Footpath bands whose bounds reach within `radius`. `PedestrianField.near`,
   * appending into `out` so nothing allocates. Called at most once per giver per
   * session -- see the heading cache.
   */
  bandsNear(x: number, z: number, radius: number, out: PedBand[]): PedBand[];
}

/** One pooled rig and whoever it is currently standing in for. */
interface BodySlot {
  actor: CharacterActor;
  /** The giver's id, or `''` for a free slot. A flag, never a sentinel index. */
  id: string;
  hash: number;
  /** Which of the seven kit geometries the rig is wearing. See `assign`. */
  kit: number;
  x: number;
  y: number;
  z: number;
  restYaw: number;
  /** `TURN_RANGE_SCALE` times the giver's dialog radius, read once on the beat. */
  turnRange: number;
  stance: GiverStance;
  /** World y of `BONE.HEAD`, refreshed after the pose. What the mark hangs off. */
  headY: number;
}

/** Reused; the pose path allocates nothing. See the header and the check. */
const _head = /*#__PURE__*/ new Vector3();

export class GiverBodyField {
  /** Add these to the scene. One per pooled rig, invisible until held. */
  readonly rigs: CharacterActor[] = [];

  /** How many givers were posed last frame. For the check and a console poke. */
  live = 0;
  /** Givers in range that the cap turned away. Should stay at zero; see the census. */
  dropped = 0;
  /** How long the whole update took, milliseconds. Diagnostics only. */
  costMs = 0;

  private readonly slots: BodySlot[] = [];
  private readonly selection: GiverSelection = createGiverSelection(MAX_GIVER_BODIES);
  private readonly bands: PedBand[] = [];
  private readonly kitGeometries: CharacterAssets['geometries'];
  private clock = 0;
  private lastBeat = -1;

  /**
   * The resolved resting heading per giver id.
   *
   * Resolved once and kept, which is rule 3 of the heading in
   * `game/giverbodies.ts`: a giver who re-derived a heading every time a lane
   * sidecar streamed in would pirouette as the player walked up to her. Bounded
   * by the content pool -- a hundred and three entries today, and a pack is a
   * file somebody writes rather than anything that grows at runtime.
   */
  private readonly headings = new Map<string, number>();

  constructor(characters: CharacterAssets) {
    this.kitGeometries = characters.geometries;
    for (let i = 0; i < MAX_GIVER_BODIES; i++) {
      // Seeded across the kits so an unassigned pool is not twelve copies of one
      // person, and so the first assignment usually needs no geometry swap --
      // `PedestrianCrowd`'s own reasoning about its fourteen.
      const kit = i % this.kitGeometries.length;
      const actor = new CharacterActor(characters, kit);
      actor.mesh.name = `character:giver:${i}`;
      actor.mesh.visible = false;
      this.rigs.push(actor);
      this.slots.push({
        actor,
        id: '',
        hash: 0,
        kit,
        x: 0,
        y: 0,
        z: 0,
        restYaw: 0,
        turnRange: 0,
        stance: createGiverStance(),
        headY: 0,
      });
    }
  }

  /**
   * One frame. The pose always; the decision when the marker field's beat moves.
   *
   * `beat` is `QuestMarkerField.beats`. See the header on why it is borrowed
   * rather than counted again here.
   */
  update(dt: number, beat: number, playerX: number, playerZ: number, source: GiverBodySource): void {
    const at = performance.now();
    this.clock += dt;
    if (beat !== this.lastBeat) {
      this.lastBeat = beat;
      this.assign(playerX, playerZ, source);
    }
    this.pose(dt, playerX, playerZ);
    this.costMs = performance.now() - at;
  }

  /**
   * The world y of a drawn giver's head bone, or `null` if she has no body.
   *
   * A linear scan over twelve slots rather than a `Map`, because the caller asks
   * at most twelve times on a beat -- a hundred and forty-four string compares
   * four times a second -- and a `Map` rebuilt on every assignment would be the
   * only allocation in this file.
   */
  headY(id: string): number | null {
    for (const slot of this.slots) {
      if (slot.id === id) return slot.headY;
    }
    return null;
  }

  /** Where the mark over this giver belongs: off her head if she has one, else off the ground. */
  markY(id: string, groundY: number): number {
    const head = this.headY(id);
    return head === null ? markYFromGround(groundY) : markYFromHeadBone(head);
  }

  /**
   * Hand the nearest givers a rig, keeping the ones already assigned. On the beat.
   *
   * Two passes and no sort, `PedestrianCrowd.assign`'s arrangement: the first
   * keeps every slot whose giver is still selected, the second fills what is
   * left from the selection in nearest-first order. Unlike the crowd there is no
   * hysteresis band, and there does not need to be one -- a giver does not move,
   * so the only thing that can push her over the boundary is the player walking,
   * and at 150 m the swap is a body appearing or vanishing at two pixels.
   */
  private assign(playerX: number, playerZ: number, source: GiverBodySource): void {
    const npcs = source.npcs();
    const sel = this.selection;
    selectGivers(sel, npcs, playerX, playerZ, GIVER_BODY_RANGE_M);
    this.dropped = sel.dropped;

    // First pass: let go of every slot whose giver is no longer selected. It has
    // to happen before the fill, or a pool at capacity could not hand a rig to
    // somebody nearer than whoever just walked out of range.
    for (const slot of this.slots) {
      if (slot.id === '') continue;
      let held = false;
      for (let i = 0; i < sel.count; i++) {
        if (npcs[sel.index[i]].id === slot.id) {
          held = true;
          break;
        }
      }
      if (held) continue;
      slot.id = '';
      slot.actor.mesh.visible = false;
    }

    for (let i = 0; i < sel.count; i++) {
      const npc = npcs[sel.index[i]];
      let slot: BodySlot | null = null;
      for (const candidate of this.slots) {
        if (candidate.id === npc.id) {
          slot = candidate;
          break;
        }
      }
      if (slot === null) {
        for (const candidate of this.slots) {
          if (candidate.id === '') {
            slot = candidate;
            break;
          }
        }
        if (slot === null) break;
        this.take(slot, npc, source);
      }
      // The ground is re-sampled on every beat rather than only on assignment,
      // because the terrain under a giver arrives with her tile: a giver claimed
      // on the frame her tile is still decoding would otherwise stand at
      // whatever `wildGround` answered before it had anything to answer with,
      // forever. Twelve samples four times a second.
      slot.x = npc.x;
      slot.z = npc.z;
      slot.y = source.groundAt(npc.x, npc.z);
      slot.turnRange = npc.radius * TURN_RANGE_SCALE;
      // ...and the heading again, for the same reason: a giver claimed before
      // her tile's lane sidecar arrived is on the hash fallback, and this is
      // where she is upgraded once there is a footpath to face. `resolveHeading`
      // caches the moment it has an answer and never probes again, so the cost
      // is one grid walk a beat for as long as a giver has no street -- and the
      // *turn* it can cause happens at most once per giver per session. In
      // practice never: a tile 150 m away has had its lanes for a long time by
      // the time a giver inside it is selected, so the answer is there on the
      // first beat and there is nothing to upgrade from.
      slot.restYaw = this.resolveHeading(npc, source);
    }
  }

  /**
   * Rule 1/2 if a footpath answers, rule 3 if none does, and cached forever once
   * it is the former. See `headings` and `game/giverbodies.ts`'s heading section.
   */
  private resolveHeading(npc: DialogNpc, source: GiverBodySource): number {
    const cached = this.headings.get(npc.id);
    if (cached !== undefined) return cached;
    const heading = bandHeading(npc.x, npc.z, source.bandsNear(npc.x, npc.z, FOOTPATH_PROBE_M, this.bands));
    if (heading === null) return hashHeading(npc.id);
    this.headings.set(npc.id, heading);
    return heading;
  }

  /** A free slot takes a giver: her kit, her heading, and her place in the idle cycle. */
  private take(slot: BodySlot, npc: DialogNpc, source: GiverBodySource): void {
    slot.id = npc.id;
    slot.hash = giverHash(npc.id);

    // The kit, swapped by reference and only when it changes. All seven
    // geometries share position, normal, skinIndex and skinWeight and differ
    // only in their colour attribute, so the skeleton, the bind matrix and the
    // bounding sphere are all still correct -- `PedestrianCrowd.assign` carries
    // the full argument and nothing in `player/character.ts` had to change for
    // either of us.
    const kit = giverKit(npc.id) % this.kitGeometries.length;
    if (kit !== slot.kit) {
      slot.actor.mesh.geometry = this.kitGeometries[kit] ?? this.kitGeometries[0];
      slot.kit = kit;
    }

    slot.restYaw = this.resolveHeading(npc, source);
    slot.stance.yaw = slot.restYaw;
    slot.stance.headYaw = 0;
    slot.stance.engaged = false;
    slot.x = npc.x;
    slot.z = npc.z;
    slot.y = source.groundAt(npc.x, npc.z);
    slot.headY = slot.y;
    slot.turnRange = npc.radius * TURN_RANGE_SCALE;
    slot.actor.mesh.visible = true;

    // **The idle phase, spent once.** `clipIdle` runs off the actor's own
    // private clock, which starts at zero for every rig in a pool built in one
    // instant -- so twelve givers would breathe, sway and look around in perfect
    // unison, which is the single thing that would give a pool away. A rig
    // standing still has no stride to disturb and is not in the air, so a large
    // `dt` on this one call moves nothing but that clock. See
    // `game/giverbodies.giverIdlePhase`.
    slot.actor.update(giverIdlePhase(npc.id), {
      position: { x: slot.x, y: slot.y, z: slot.z },
      yaw: slot.restYaw,
      speed: 0,
      onGround: true,
    });
  }

  /** Every held slot, every frame: the turn, the rig, and the head the mark hangs off. */
  private pose(dt: number, playerX: number, playerZ: number): void {
    let live = 0;
    for (const slot of this.slots) {
      if (slot.id === '') continue;
      live++;
      const stance = slot.stance;
      poseGiver(
        stance,
        slot.hash,
        slot.restYaw,
        slot.x,
        slot.z,
        playerX,
        playerZ,
        slot.turnRange,
        this.clock,
        dt,
      );
      slot.actor.update(dt, {
        position: { x: slot.x, y: slot.y, z: slot.z },
        yaw: stance.yaw,
        // Standing. A giver fed a speed would drive the stride and walk on the
        // spot, and there is nowhere for her to go: she is not an actor.
        speed: 0,
        onGround: true,
      });
      // **After `update`**, because that is what writes the bones -- exactly
      // `CharacterCrowd.raisePhone`'s placement and for its reason. The head
      // leading the body through a turn is two lines here rather than a sixth
      // reaction in `player/animation.ts`, which is a file this feature does not
      // own.
      if (stance.headYaw !== 0) slot.actor.bones[BONE.HEAD].rotation.y += stance.headYaw;
      // And the head bone into world space, up the ancestor chain only. The mark
      // reads this on its own beat.
      slot.actor.refreshHeadMatrix();
      slot.headY = slot.actor.headPosition(_head).y;
    }
    this.live = live;
  }

  /**
   * Release the rigs. **Not the geometry or the material**, which are
   * `CharacterAssets`' and are drawn by every figure in the city -- the trap
   * `streamer.dispose` documents at length and `CharacterCrowd.dispose` restates.
   */
  dispose(): void {
    for (const slot of this.slots) slot.actor.mesh.removeFromParent();
  }
}

// --- The self-check ---------------------------------------------------------------

/**
 * The drawing half's own failures, which are the ones the pure check cannot see.
 *
 * `game/giverbodies.verifyGiverBodies` covers the arithmetic and runs in both
 * runtimes; this needs a `CharacterAssets` and therefore a browser, and it runs
 * beside `verifyQuestMarkers` in `main.ts`'s boot list. What only this can catch:
 *
 *   - **The two features' constants drifting.** The range and the cap are
 *     restated in a three-free module because the server compiles it, and the
 *     moment somebody widens `MARKER_RANGE_M` without widening this one there
 *     are marks over givers with no bodies again -- the exact defect the whole
 *     workstream was asked to remove, reintroduced by an edit to a different
 *     file.
 *   - **A slot that never lets go.** A pool where `assign` frees nothing is a
 *     giver's body left standing in Redfern after she is out of range, and the
 *     pool exhausts after twelve givers for the rest of the session.
 *   - **The head not moving with the body.** `headY` reading a stale bone -- or
 *     the pose forgetting `refreshHeadMatrix` -- gives a mark pinned to wherever
 *     the rig was constructed, which on a flat street is very nearly right.
 *   - **The kit not surviving a reassignment**, which is a giver who changes
 *     clothes when the player walks away and comes back.
 */
export function verifyGiverBodyField(characters: CharacterAssets): string[] {
  const failures: string[] = [];

  // --- The constants the two features share. The only place both are visible.
  if (GIVER_BODY_RANGE_M !== MARKER_RANGE_M) {
    failures.push(
      `Bodies are drawn to ${GIVER_BODY_RANGE_M} m and marks to ${MARKER_RANGE_M} m; there would be marks over nobody.`,
    );
  }
  if (MAX_GIVER_BODIES !== MAX_MARKERS) {
    failures.push(`The body cap is ${MAX_GIVER_BODIES} and the mark cap is ${MAX_MARKERS}; the two selections can disagree.`);
  }
  if (characters.geometries.length !== PEDESTRIAN_KIT_COUNT) {
    failures.push(
      `The wardrobe has ${characters.geometries.length} kits and \`giverKit\` picks out of ${PEDESTRIAN_KIT_COUNT}.`,
    );
  }

  const field = new GiverBodyField(characters);
  if (field.rigs.length !== MAX_GIVER_BODIES) failures.push(`The pool built ${field.rigs.length} rigs, not ${MAX_GIVER_BODIES}.`);
  for (const rig of field.rigs) {
    if (rig.mesh.visible) failures.push('A rig in an unassigned pool is visible; there is a stranger standing at the origin.');
    if (!rig.mesh.castShadow) failures.push('A giver casts no shadow; she would not be standing on the footpath.');
    if (!rig.mesh.receiveShadow) failures.push('A giver does not receive shadow; she would be lit as though always in the sun.');
  }

  const npc = (id: string, x: number, z: number): DialogNpc =>
    parseDialogPack(
      {
        npcs: [
          {
            id,
            x,
            z,
            radius: 5,
            nodes: [{ id: 'hello', line: 'gday', choices: [{ text: 'the job', accept: 'j' }] }],
          },
        ],
      },
      'fixture',
    ).value.npcs[0];

  // A street to face, so the heading rule is exercised through the real bands
  // rather than through its fallback.
  const tile = syntheticGrid();
  const streetBands = tile === null ? [] : buildBands(tile, () => 1);
  const source = (people: readonly DialogNpc[], ground = 0): GiverBodySource => ({
    npcs: () => people,
    groundAt: () => ground,
    bandsNear: (_x, _z, _r, out) => {
      out.length = 0;
      for (const band of streetBands) out.push(band);
      return out;
    },
  });

  // --- Nobody anywhere: nothing drawn, nothing thrown. The state every session
  // starts in, before `/content` has answered.
  field.update(1 / 60, 1, 0, 0, source([]));
  if (field.live !== 0) failures.push(`An empty bundle posed ${field.live} bodies.`);

  // --- One giver in range gets a body, and the mark comes off her head. The
  // player is 68 m away: inside the body range, well outside twice her dialog
  // radius, so she is at her post rather than looking at him.
  const denise = npc('centrelink-clerk', -8, -150);
  field.update(1 / 60, 2, 60, -150, source([denise], 3.5));
  if (field.live !== 1) failures.push(`One giver in range posed ${field.live} bodies.`);
  {
    const head = field.headY('centrelink-clerk');
    if (head === null) failures.push('A drawn giver has no head height; the mark would still float off the ground.');
    else {
      // Standing on ground 3.5 in something close to the bind pose: the head bone
      // is about 1.25 m up. A metre of tolerance would pass a mark pinned to the
      // origin, so this is tight enough to convict that.
      if (Math.abs(head - (3.5 + 1.25)) > 0.15) {
        failures.push(`A giver on ground 3.5 m has her head bone at ${head.toFixed(2)} m; that is not a standing figure.`);
      }
      // ...and the mark off that head must be where the old ground arithmetic put
      // it, or every mark in Sydney jumps on the beat a body appears.
      const off = Math.abs(field.markY('centrelink-clerk', 3.5) - markYFromGround(3.5));
      if (off > 0.1) failures.push(`The mark moves ${off.toFixed(3)} m when a body appears under it.`);
    }
  }
  if (field.markY('nobody-here', 12) !== markYFromGround(12)) {
    failures.push('A giver with no body did not fall back to the ground height for her mark.');
  }
  // She is standing on a north-south street's western side, so she faces east.
  {
    const rig = field.rigs.find((r) => r.mesh.visible);
    if (rig === undefined) failures.push('A posed giver has no visible rig.');
    else if (Math.abs(rig.mesh.rotation.y + Math.PI / 2) > 0.35) {
      failures.push(`A giver west of a north-south street faces ${rig.mesh.rotation.y.toFixed(2)} rad rather than the road.`);
    }
  }

  // --- The turn. A player who walks up to her is looked at; the same beat, so
  // this is the pose path rather than a reassignment. Six metres due south of
  // her is +Z, which is a half turn.
  for (let i = 0; i < 120; i++) field.update(1 / 60, 2, -8, -144, source([denise], 3.5));
  {
    const rig = field.rigs.find((r) => r.mesh.visible);
    if (rig !== undefined && Math.abs(Math.abs(rig.mesh.rotation.y) - Math.PI) > 0.05) {
      failures.push(`A giver did not turn to a player six metres away; she is at ${rig.mesh.rotation.y.toFixed(2)} rad.`);
    }
  }

  // --- The slot lets go, and the kit survives a round trip. A pool that never
  // frees exhausts after twelve givers and is silent until the thirteenth.
  const kitBefore = field.rigs.find((r) => r.mesh.visible)?.mesh.geometry;
  field.update(1 / 60, 3, 4000, 4000, source([denise], 3.5));
  if (field.live !== 0) failures.push(`A giver four kilometres away is still posed (${field.live} live).`);
  if (field.headY('centrelink-clerk') !== null) failures.push('A giver with no body still reports a head height.');
  for (const rig of field.rigs) {
    if (rig.mesh.visible) failures.push('A rig stayed visible after its giver left range.');
  }
  field.update(1 / 60, 4, 0, -150, source([denise], 3.5));
  const kitAfter = field.rigs.find((r) => r.mesh.visible)?.mesh.geometry;
  if (kitBefore !== undefined && kitAfter !== kitBefore) {
    failures.push('A giver came back in a different kit; the appearance is not a function of the id.');
  }

  // --- The cap, over more givers than there are slots. A rig pool that
  // overflowed would be an undefined slot rather than a silent buffer write, but
  // the counter is the thing that would say so.
  {
    const crowd: DialogNpc[] = [];
    for (let i = 0; i < MAX_GIVER_BODIES + 5; i++) crowd.push(npc(`n${i}`, i * 3 + 3, -150));
    field.update(1 / 60, 5, 0, -150, source(crowd, 3.5));
    if (field.live !== MAX_GIVER_BODIES) failures.push(`${crowd.length} givers posed ${field.live} bodies against a cap of ${MAX_GIVER_BODIES}.`);
    if (field.dropped !== 5) failures.push(`${crowd.length} givers over a ${MAX_GIVER_BODIES} cap dropped ${field.dropped}, not 5.`);
    let visible = 0;
    for (const rig of field.rigs) if (rig.mesh.visible) visible++;
    if (visible !== MAX_GIVER_BODIES) failures.push(`${visible} rigs are visible against ${field.live} posed givers.`);
    // Every one of them reports a head, or a mark somewhere in that crowd floats.
    for (const person of crowd.slice(0, MAX_GIVER_BODIES)) {
      if (field.headY(person.id) === null) failures.push(`"${person.id}" is drawn and reports no head height.`);
    }
  }

  // --- The pose path's scratch, asserted by structure.
  //
  // There is exactly one `Vector3` in this module and it is a module-level
  // constant, so "the pose path allocates nothing" is a property of the file
  // rather than of a measurement. What can still be checked from out here is
  // that the field is *using* it -- a refactor that made a fresh vector per
  // giver per frame would leave this one holding whatever it held at boot, and
  // the head heights would go on being right.
  {
    _head.set(NaN, NaN, NaN);
    field.update(1 / 60, 6, 60, -150, source([denise], 3.5));
    if (!Number.isFinite(_head.y)) failures.push('The pose path did not write the shared head scratch; something allocates per frame.');
    const head = field.headY('centrelink-clerk');
    if (head !== null && Math.abs(head - _head.y) > 1e-9) {
      failures.push('The reported head height is not the one the shared scratch holds.');
    }
  }

  field.dispose();
  return failures;
}
