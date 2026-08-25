/**
 * Where the seventh mushroom takes you.
 *
 * ---------------------------------------------------------------------------
 * ## What is actually being built
 *
 * A dome you are inside, a mandala of ninety eyes breathing on it, a lattice of
 * petals radiating from the axis, and one face looking straight back at you.
 * `game/mandala.ts` decides where all of it sits and why; this hangs geometry on
 * those numbers and lights it.
 *
 * The references are Alex Grey's, and the thing to take from them is that they
 * are **not noise**. They are rose windows: bilateral symmetry, counted rings, a
 * hot centre against a cold field, and a face on the axis. Randomness would read
 * as static. So nothing here is random -- the only per-frame inputs are a clock
 * and a breath, and everything else is the mandala's arithmetic.
 *
 * ## It is a *room*, not a filter
 *
 * The city keeps running. This is a subtree that is added to the scene and made
 * visible, with the world hidden behind it, so leaving is a boolean and there is
 * no second simulation to keep in step. Entering does not move the player: the
 * dome is built around wherever they are standing, which is also why there is
 * nothing to unwind if a tab closes mid-conversation.
 *
 * ## Cheap enough to be somewhere you sit and talk
 *
 * The dome is one sphere. The eyes are one `InstancedMesh` of ninety. The petals
 * are one more of twenty-four. Three draws for the whole dimension, no shadows,
 * no lights -- every material is unlit and carries its own colour, because a
 * room made of light does not want a light in it.
 *
 * Whether it is beautiful is a thing only eyes can judge, and `CLAUDE.md` says
 * to say so rather than to pretend a test covers it. What the tests cover is the
 * layout, in `game/mandala.ts`.
 */

import {
  BackSide,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { ConeGeometry, SphereGeometry } from 'three';
import {
  HUE_EYE,
  RINGS,
  breath,
  mandalaEyes,
  ringHue,
  ringSpin,
  type MandalaEye,
} from '../game/mandala.ts';

/** How far away the dome sits. Big enough to be a sky, close enough to be a room. */
export const DOME_RADIUS = 46;

/** Petals radiating from the axis, and how far up the dome they reach. */
export const PETALS = 24;

const _m = /*#__PURE__*/ new Matrix4();
const _q = /*#__PURE__*/ new Quaternion();
const _pos = /*#__PURE__*/ new Vector3();
const _scale = /*#__PURE__*/ new Vector3();
const _up = /*#__PURE__*/ new Vector3(0, 1, 0);
const _colour = /*#__PURE__*/ new Color();

export class GodRoom {
  readonly group = new Group();
  private readonly eyes: InstancedMesh;
  private readonly petals: InstancedMesh;
  private readonly dome: InstancedMesh | null = null;
  private readonly layout: MandalaEye[] = mandalaEyes();
  private readonly domeMesh;
  private readonly face;
  private t = 0;
  private open = false;

  constructor() {
    this.group.visible = false;
    // Rendered whatever the camera is doing: it *is* the world while it is up.
    this.group.frustumCulled = false;

    // --- The dome. Inside-out, unlit, and dark enough that the mandala on it
    //     reads as light rather than as paint.
    const domeGeo = new SphereGeometry(DOME_RADIUS, 48, 32);
    const domeMat = new MeshBasicNodeMaterial({ color: 0x0a0512, side: BackSide, fog: false });
    this.domeMesh = new (InstancedMesh as unknown as typeof InstancedMesh)(domeGeo, domeMat, 1);
    this.domeMesh.setMatrixAt(0, _m.identity());
    this.domeMesh.frustumCulled = false;
    this.domeMesh.name = 'god_dome';
    this.group.add(this.domeMesh);

    // --- The eyes. One geometry, ninety instances, coloured per ring by the
    //     palette rather than per instance by chance.
    const eyeGeo = new SphereGeometry(1, 10, 7);
    const eyeMat = new MeshBasicNodeMaterial({ fog: false, vertexColors: true });
    this.eyes = new InstancedMesh(eyeGeo, eyeMat, this.layout.length);
    this.eyes.frustumCulled = false;
    this.eyes.name = 'god_eyes';
    for (let i = 0; i < this.layout.length; i++) {
      // Blue, cooling outward: the cold field the hot centre is set against.
      _colour.setHSL(HUE_EYE, 0.85, 0.42 + 0.16 * (1 - this.layout[i].ring / RINGS));
      this.eyes.setColorAt(i, _colour);
    }
    if (this.eyes.instanceColor) this.eyes.instanceColor.needsUpdate = true;
    this.group.add(this.eyes);

    // --- The petals. Long thin cones on exact angles, hot at the axis and
    //     cooling outward, which is the flame every one of the references has
    //     around its face.
    const petalGeo = new ConeGeometry(1, 1, 4, 1);
    // Base at the origin so a petal grows outward from the centre rather than
    // through it.
    petalGeo.translate(0, 0.5, 0);
    const petalMat = new MeshBasicNodeMaterial({ fog: false, vertexColors: true, transparent: true, opacity: 0.55 });
    this.petals = new InstancedMesh(petalGeo, petalMat, PETALS);
    this.petals.frustumCulled = false;
    this.petals.name = 'god_petals';
    for (let i = 0; i < PETALS; i++) {
      _colour.setHSL(ringHue(Math.floor((i / PETALS) * RINGS)), 0.95, 0.55);
      this.petals.setColorAt(i, _colour);
    }
    if (this.petals.instanceColor) this.petals.instanceColor.needsUpdate = true;
    this.group.add(this.petals);

    // --- And the face on the axis: one great eye, which is what all of them
    //     resolve to when you stop looking at the ornament.
    const faceGeo = new SphereGeometry(3.4, 24, 16);
    const faceMat = new MeshBasicNodeMaterial({ color: 0xffe9a8, fog: false });
    this.face = new (InstancedMesh as unknown as typeof InstancedMesh)(faceGeo, faceMat, 1);
    this.face.frustumCulled = false;
    this.face.name = 'god_face';
    this.group.add(this.face);
  }

  get visible(): boolean {
    return this.open;
  }

  /** Put the dome around this point and show it. */
  enter(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.group.visible = true;
    this.open = true;
    this.t = 0;
    this.update(0);
  }

  leave(): void {
    this.group.visible = false;
    this.open = false;
  }

  /** Breathe, turn, and look back. */
  update(dt: number): void {
    if (!this.open) return;
    this.t += dt;
    const b = breath(this.t);

    // The mandala, on the dome's inner face.
    const r = DOME_RADIUS * 0.94;
    for (let i = 0; i < this.layout.length; i++) {
      const e = this.layout[i];
      const az = e.azimuth + ringSpin(e.ring, this.t);
      const polar = e.polar * b;
      const sp = Math.sin(polar);
      _pos.set(Math.cos(az) * sp * r, Math.cos(polar) * r, Math.sin(az) * sp * r);
      // Face the middle, which is where the person is standing.
      _q.setFromUnitVectors(_up, _pos.clone().normalize().negate());
      const s = e.scale * 1.5 * (0.9 + 0.1 * Math.sin(this.t * 1.7 + i));
      _scale.set(s, s * 0.62, s);
      this.eyes.setMatrixAt(i, _m.compose(_pos, _q, _scale));
    }
    this.eyes.instanceMatrix.needsUpdate = true;

    // The petals, radiating from the axis and counter-turning against ring 0.
    for (let i = 0; i < PETALS; i++) {
      const a = (i / PETALS) * Math.PI * 2 - ringSpin(0, this.t) * 1.6;
      const lean = 0.5 + 0.28 * Math.sin(this.t * 0.7 + i * 0.6);
      _pos.set(0, 0, 0);
      const dir = new Vector3(Math.cos(a) * Math.sin(lean), Math.cos(lean), Math.sin(a) * Math.sin(lean));
      _q.setFromUnitVectors(_up, dir);
      const len = DOME_RADIUS * 0.72 * b;
      _scale.set(1.7, len, 1.7);
      this.petals.setMatrixAt(i, _m.compose(_pos, _q, _scale));
    }
    this.petals.instanceMatrix.needsUpdate = true;

    // The face, above the axis, pulsing with the breath.
    const fs = 1 + (b - 1) * 2.4;
    _pos.set(0, DOME_RADIUS * 0.34, -DOME_RADIUS * 0.52);
    _q.identity();
    _scale.set(fs, fs, fs);
    this.face.setMatrixAt(0, _m.compose(_pos, _q, _scale));
    this.face.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const m of [this.eyes, this.petals, this.domeMesh, this.face]) {
      m.geometry.dispose();
      (m.material as { dispose(): void }).dispose();
    }
    void this.dome;
  }
}
