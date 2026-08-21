/**
 * The door you get on at, drawn on the door you get on at.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A THING IN THE WORLD AND NOT JUST A LINE IN THE HUD.
 *
 * Reported, verbatim: *"there is no sign for the train station, its not obvious
 * where i board"*. The build it was reported against had a prompt -- `E to board
 * the T4 to Cronulla` -- and the prompt is not an answer to that sentence. It
 * appears only once you are already within three metres of a doorway, it says
 * nothing about *which* doorway, and a player standing in the middle of a 5.5 m
 * platform beside a 164 m train has no way to discover that the reach exists.
 * "I could not find the thing" is not fixed by a caption on the thing.
 *
 * So there are two objects now and they answer two different questions.
 * `rail-geo.writeStationBoard` answers "is there a station here", from the
 * street. This one answers "and where do I stand", from the platform: a ring on
 * the vestibule floor of the nearest open doorway with a chevron over it, live
 * for the fifteen seconds the doors are open and gone the moment they shut.
 *
 * ---------------------------------------------------------------------------
 * TWO STATES, AND THE DIFFERENCE IS THE POINT.
 *
 * **In reach** -- `findBoarding` would say yes -- it is bright and the chevron
 * points down into the door: press the key. **Out of reach** it is dimmer, amber
 * and larger, and the chevron rides higher so it clears the crowd and the
 * canopy: walk here first. The two are the same object because they are the same
 * doorway, and a player who walks toward the amber one watches it turn bright
 * under their feet, which teaches the rule without a line of text.
 *
 * Unlit and `depthWrite` off, like every other diegetic overlay in this
 * renderer: it is a piece of signage, not a surface, and it must read the same
 * at 3 am under a sodium lamp as at noon.
 */
import {
  AdditiveBlending,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  RingGeometry,
} from 'three/webgpu';

import type { WarmupPart } from './warmup.ts';

/** How far away a standing train's doors are still worth pointing at, metres. */
export const BOARD_HINT_M = 45;

/** In reach: the ring sits on the sill and the chevron is a hand's breadth over it. */
const NEAR_RING = 0.62;
const NEAR_CHEVRON_Y = 1.35;
/** Out of reach: bigger and higher, because it is being read across a platform. */
const FAR_RING = 0.95;
const FAR_CHEVRON_Y = 2.45;

const NEAR_COLOUR: number = 0x8ff0ff;
const FAR_COLOUR: number = 0xffb648;

export class DoorMarker {
  readonly group = new Group();
  private readonly ring: Mesh;
  private readonly chevron: Mesh;
  private readonly ringMat: MeshBasicNodeMaterial;
  private readonly chevronMat: MeshBasicNodeMaterial;
  private phase = 0;
  private near = true;

  constructor() {
    this.group.name = 'rail_door_marker';
    this.group.visible = false;
    // Not frustum-culled: the group's bounding sphere is the geometry's own,
    // centred on the origin, and it is moved by the group transform every frame
    // -- three would cull it against a sphere that is always at (0,0,0). The object is
    // twelve triangles and there is exactly one of it.
    this.group.frustumCulled = false;

    this.ringMat = new MeshBasicNodeMaterial();
    this.ringMat.name = 'rail_door_ring';
    this.ringMat.transparent = true;
    this.ringMat.depthWrite = false;
    this.ringMat.blending = AdditiveBlending;
    this.ringMat.side = DoubleSide;
    this.ringMat.fog = false;
    this.ringMat.toneMapped = false;

    this.chevronMat = new MeshBasicNodeMaterial();
    this.chevronMat.name = 'rail_door_chevron';
    this.chevronMat.transparent = true;
    this.chevronMat.depthWrite = false;
    this.chevronMat.blending = AdditiveBlending;
    this.chevronMat.fog = false;
    this.chevronMat.toneMapped = false;

    // A flat annulus, lying on the floor. Built at radius 1 and scaled, so the
    // two states cost no geometry.
    const ring = new RingGeometry(0.74, 1, 40);
    ring.rotateX(-Math.PI / 2);
    this.ring = new Mesh(ring, this.ringMat);
    this.ring.frustumCulled = false;
    this.group.add(this.ring);

    // And a cone pointing down at it, which is a chevron anybody has seen
    // before and costs sixteen triangles.
    const cone = new ConeGeometry(0.26, 0.52, 8);
    cone.rotateX(Math.PI);
    this.chevron = new Mesh(cone, this.chevronMat);
    this.chevron.frustumCulled = false;
    this.group.add(this.chevron);
  }

  /**
   * Put it on a doorway. `inReach` is `findBoarding`'s own answer and nothing
   * else -- so the bright state means, exactly, "the key would work now".
   */
  aim(x: number, y: number, z: number, inReach: boolean): void {
    this.group.position.set(x, y + 0.03, z);
    this.group.visible = true;
    this.near = inReach;
    const r = inReach ? NEAR_RING : FAR_RING;
    this.ring.scale.set(r, 1, r);
    this.chevron.position.y = inReach ? NEAR_CHEVRON_Y : FAR_CHEVRON_Y;
    this.chevron.scale.setScalar(inReach ? 1 : 1.35);
    this.ringMat.color.setHex(inReach ? NEAR_COLOUR : FAR_COLOUR);
    this.chevronMat.color.setHex(inReach ? NEAR_COLOUR : FAR_COLOUR);
  }

  hide(): void {
    this.group.visible = false;
  }

  /**
   * The breathing, once a frame. A static ring reads as scenery and a flashing
   * one reads as an error; a slow sine is how every wayfinding marker in every
   * game says "this one, now".
   */
  update(dt: number): void {
    if (!this.group.visible) return;
    this.phase = (this.phase + dt * (this.near ? 2.6 : 1.5)) % (Math.PI * 2);
    const pulse = 0.5 + 0.5 * Math.sin(this.phase);
    this.ringMat.opacity = (this.near ? 0.55 : 0.35) + pulse * 0.35;
    this.chevronMat.opacity = (this.near ? 0.6 : 0.4) + pulse * 0.3;
    this.chevron.position.y += Math.sin(this.phase) * 0.0015;
    this.group.rotation.y += dt * (this.near ? 0.9 : 0.5);
  }

  dispose(): void {
    this.ring.geometry.dispose();
    this.chevron.geometry.dispose();
    this.ringMat.dispose();
    this.chevronMat.dispose();
  }

  /**
   * The boot warm-up entries, and this object is the textbook case for one.
   *
   * WORKSTREAM AE. The marker is constructed hidden -- `group.visible = false`
   * in the constructor, and `aim` is the only thing that ever shows it -- and
   * `_projectObject` skips an invisible object in `compileAsync`'s walk exactly
   * as it does in `render`. So the boot scene pass, which is what covers
   * everything else that is merely sitting in the scene, could never reach these
   * two: their pipelines compiled on the frame the marker first appeared, which
   * is the frame a player walks up to a train door. That is a stall placed
   * precisely on the action it exists to make obvious, and it is one of the
   * things behind *"looking around on the train has little freezes"*.
   *
   * The real meshes are handed over rather than stood in for, because they are
   * two objects with twelve triangles between them: a throwaway would be the same
   * pipeline at the cost of a `RingGeometry` nobody needs. Neither casts nor
   * receives -- both are unlit additive signage, see the header.
   */
  warmupParts(): WarmupPart[] {
    return [
      { geometry: this.ring.geometry, material: this.ringMat, casts: false, receives: [false] },
      { geometry: this.chevron.geometry, material: this.chevronMat, casts: false, receives: [false] },
    ];
  }
}

/**
 * The self-check: the two states differ in every way a player can perceive.
 *
 * Small, and worth having anyway -- a marker whose "in reach" and "out of reach"
 * looked the same would be a marker that teaches nothing, and that is a
 * regression no rendering test would catch.
 */
export function verifyDoorMarker(): string[] {
  const bad: string[] = [];
  if (!(FAR_RING > NEAR_RING)) bad.push('the out-of-reach ring is not larger than the in-reach one');
  if (!(FAR_CHEVRON_Y > NEAR_CHEVRON_Y)) {
    bad.push('the out-of-reach chevron does not ride higher, so it is hidden by the canopy it exists to clear');
  }
  if (NEAR_COLOUR === FAR_COLOUR) bad.push('the two states are the same colour');
  if (BOARD_HINT_M < 20) {
    bad.push(`the hint reaches ${BOARD_HINT_M} m, which is less than a 164 m train is long`);
  }
  return bad;
}
