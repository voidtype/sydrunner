/**
 * The inside of a building, as something the renderer can draw.
 *
 * `world/interior.ts` owns the geometry and is three-free, because the server
 * imports it. This is the other twenty lines: one `BufferGeometry`, one
 * material shared by every interior in the game, and the two calls that swap
 * one building's rooms for another's.
 *
 * ## One material, one mesh, one layer
 *
 * **One material** because three keys a `RenderObject`'s node graph and its
 * compiled WGSL on the material -- `world/asyncpipes.ts` and
 * `world/instancepool.ts` are both about what happens when that number grows --
 * so a material per building would be a compile per building, at the exact
 * moment a player is walking through a door. The shading is in the vertex
 * colours instead; see `interiorMesh`.
 *
 * **One mesh**, rebuilt on entry rather than pooled, because an interior is a
 * few hundred triangles and a player opens a door a few times an hour. There is
 * nothing here worth an allocator.
 *
 * **One layer**, and this is the part that does the real work. An interior is a
 * separate world at the *same coordinates* as the building it is inside, so the
 * city is standing in it: the terrace's own walls, the street outside, the
 * traffic, the sky. Rather than hide a few dozen scene children by hand and
 * remember what each of them was -- and get it wrong for anything the streamer
 * adds while a player is indoors -- the interior goes on its own layer and the
 * camera is pointed at that layer alone. One line each way, and it is exact:
 * nothing added to layer 0 while the camera is on `INTERIOR_LAYER` can appear,
 * ever, whoever added it.
 */
import { ClippingGroup, Plane, Vector3,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type Scene,
} from 'three/webgpu';
import { liftCabDoorMesh, liftLandingMesh, CAB_DOOR_SLIDE, liftCabMesh, CORE, ghostMesh, interiorMesh, liftSignsOf, type Interior, type InteriorDoor } from './interior.ts';
import type { Placement } from './placeables.ts';

/**
 * The layer an interior is drawn on, and the city is not.
 *
 * **2, and the two numbers below it are both taken.** 0 is what every object in
 * three is born on and is therefore the city by definition. 1 is
 * `player/character.SELF_SHADOW_LAYER` -- the player's own body and its props,
 * moved off the view camera so you do not have your own head in your face, and
 * kept on the shadow camera so you still cast one. Using it here would put a
 * player's own skull in front of them the moment they walked into a pub, and
 * would render the whole interior into the shadow map.
 *
 * 2 is otherwise unused, and the shadow camera does not have it enabled, so an
 * interior casts no shadow -- which is right, because it is unlit.
 */
/** How many planes the world's hole always has. See `InteriorView.setWorldHole`. */
export const WORLD_HOLE_PLANES = 12;

export const INTERIOR_LAYER = 2;

/**
 * Every interior in the game, drawn with this.
 *
 * Unlit and double-sided. Unlit because the shading is baked (see the header);
 * double-sided because a partition is a pair of quads eight centimetres apart
 * and a player who walks into the reveal of a doorway would otherwise see
 * through the wall for the half-metre it takes to walk out again.
 */
function createInteriorMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.vertexColors = true;
  material.side = DoubleSide;
  return material;
}

/**
 * The one interior currently on screen, or none.
 *
 * Holds at most one mesh, because a player is in at most one building. `show`
 * replaces whatever was there; `hide` takes it away and puts the camera back on
 * the city.
 */
export class InteriorView {
  private readonly material = createInteriorMaterial();
  private mesh: Mesh | null = null;
  /**
   * The customiser's preview, or none.
   *
   * A second mesh rather than part of the room's, because it changes every
   * frame a player moves their head and the room's changes when somebody puts
   * a couch down -- rebuilding a whole building's triangles sixty times a
   * second to move one preview would be the one place this feature could cost
   * anything.
   */
  private ghost: Mesh | null = null;
  /** The word over the core's mouth on every level. See `interior.liftSignsOf`. */
  private signs: Mesh[] = [];
  private readonly signTextures = new Map<string, CanvasTexture>();

  constructor(private readonly scene: Scene, private readonly world: ClippingGroup | null = null) {}

  /**
   * The hole in the world where this building is. Everything the streamer
   * draws lives under one `ClippingGroup`, and while a body is inside, its
   * planes are the building's shell (pointing out, intersection semantics:
   * a fragment is cut only when it is inside every plane, that is inside the
   * shell). The trees, bins, pedestrians and terrain that stood inside the
   * footprint stop drawing in the room, and the view through a window is
   * untouched -- the owner's *"outdoor floor can overlay indoor ground"* and
   * his screenshot of a canopy through the ceiling on York Street. Always
   * `WORLD_HOLE_PLANES` planes, padded with ones that cut nothing, so the
   * renderer compiles one clipped variant of each material rather than one
   * per footprint shape. Interior meshes are outside the group, so they are
   * never cut.
   */
  setWorldHole(it: Interior | null): void {
    const world = this.world;
    if (world === null) return;
    if (it === null) {
      world.enabled = false;
      return;
    }
    const planes: Plane[] = [];
    const shell = it.planes.slice(0, WORLD_HOLE_PLANES);
    for (const pl of shell) planes.push(new Plane(new Vector3(-pl.nx, 0, -pl.nz), pl.d));
    // The padding: a plane every point is under, so it never decides.
    while (planes.length < WORLD_HOLE_PLANES) planes.push(new Plane(new Vector3(0, 1, 0), -1e9));
    world.clippingPlanes = planes;
    world.clipIntersection = true;
    world.enabled = true;
  }

  /** Is an interior currently being drawn? */
  get active(): boolean {
    return this.mesh !== null;
  }

  /**
   * Draw this building's inside, and point the camera at it alone.
   *
   * The door comes off the interior, so everybody in the building sees the way
   * out on the same wall.
   */
  show(camera: Camera, it: Interior, door: InteriorDoor = it.door): void {
    this.hide(camera);
    this.rebuild(it, door);
    this.setWorldHole(it);
    // The room's layer *and* the city's. The windows are holes in the shell
    // now, and what is through them is the street: the owner, after a walk
    // through the city, "it would be more immersive if i could look out of
    // windows inside". The building's own exterior mesh is single-sided and
    // faces out, so from inside its walls are back faces and are culled; the
    // room's shell is what you see, and through its windows, Sydney.
    camera.layers.set(INTERIOR_LAYER);
    camera.layers.enable(0);
  }

  /**
   * Rebuild the room's triangles in place, keeping the camera where it is.
   *
   * Called when somebody furnishes the building. Separate from `show` because
   * `show` is also the thing that takes the camera off the city, and doing that
   * again every time a couch lands would be a layer switch per placement for no
   * reason -- and would fight anything that had legitimately changed it.
   */
  /** The lift cab, or null for a building without one. Its height follows `liftFloorY`. */
  private cab: Mesh | null = null;
  /** The cab's two doors, sliding along the across axis. */
  private cabDoors: [Mesh, Mesh] | null = null;
  /** The landing doors, one per level, drawn where the cab is not. */
  private landings: Mesh[] = [];
  private cabAcross: [number, number] = [1, 0];
  private cabSlideM = 0;

  /** Put the cab floor at this height. Cheap: one transform. */
  setCabY(y: number): void {
    if (this.cab !== null) this.cab.position.y = y;
    if (this.cabDoors !== null) for (const d of this.cabDoors) d.position.y = y;
  }

  /**
   * The doors and the landings, from the ride: `open` is 0 shut to 1 open,
   * `restLevel` the level the cab is standing at or -1 while it moves. The
   * landing at the cab's level hides so a rider walks out through an open
   * door and not a drawn one.
   */
  setCabState(open: number, restLevel: number): void {
    if (this.cabDoors !== null) {
      const slide = this.cabSlideM * Math.max(0, Math.min(1, open));
      const [ax, az] = this.cabAcross;
      this.cabDoors[0].position.x = -ax * slide;
      this.cabDoors[0].position.z = -az * slide;
      this.cabDoors[1].position.x = ax * slide;
      this.cabDoors[1].position.z = az * slide;
    }
    for (let k = 0; k < this.landings.length; k++) this.landings[k].visible = k !== restLevel;
  }

  /**
   * While the rider is in it, the cab draws over everything: the level's
   * ceiling slab sweeps down through a cab that is depth-tested against it,
   * and a floor slab up through it, which is the shaft with no hole in it
   * seen from inside. Drawn last without the depth test, the cab is the room
   * the rider is in and the slabs pass behind. Off again when it rests, so a
   * body in the corridor does not see the cab through the wall.
   */
  private cabRiding = false;
  private readonly cabMaterial = createInteriorMaterial();
  setCabRiding(riding: boolean): void {
    if (riding === this.cabRiding) return;
    this.cabRiding = riding;
    this.cabMaterial.depthTest = !riding;
    this.cabMaterial.depthWrite = !riding;
    this.cabMaterial.needsUpdate = true;
    if (this.cab !== null) this.cab.renderOrder = riding ? 3 : 0;
    if (this.cabDoors !== null) for (const d of this.cabDoors) d.renderOrder = riding ? 3 : 0;
  }

  private meshOf(built: { positions: Float32Array; normals: Float32Array; colors: Float32Array }, material: MeshBasicNodeMaterial): Mesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(built.colors, 3));
    const mesh = new Mesh(geometry, material);
    mesh.layers.set(INTERIOR_LAYER);
    mesh.frustumCulled = false;
    // Never clipped by the world's hole; see `setWorldHole`.
    mesh.userData.unclipped = true;
    return mesh;
  }

  private dropCab(): void {
    const gone: Mesh[] = [];
    if (this.cab !== null) gone.push(this.cab);
    if (this.cabDoors !== null) gone.push(...this.cabDoors);
    gone.push(...this.landings);
    for (const m of gone) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.cab = null;
    this.cabDoors = null;
    this.landings = [];
  }

  private rebuildCab(it: Interior): void {
    this.dropCab();
    const core = it.core;
    if (core === null || core.kind !== CORE.LIFT) return;
    const y0 = it.levels[0].y;
    const cab = this.meshOf(liftCabMesh(core), this.cabMaterial);
    cab.renderOrder = this.cabRiding ? 3 : 0;
    cab.position.y = y0;
    this.scene.add(cab);
    this.cab = cab;
    const doors: [Mesh, Mesh] = [this.meshOf(liftCabDoorMesh(core, -1), this.cabMaterial), this.meshOf(liftCabDoorMesh(core, 1), this.cabMaterial)];
    for (const d of doors) {
      d.renderOrder = this.cabRiding ? 3 : 0;
      d.position.y = y0;
      this.scene.add(d);
    }
    this.cabDoors = doors;
    this.cabAcross = [-core.lz, core.lx];
    this.cabSlideM = (core.hw - 0.05) * CAB_DOOR_SLIDE;
    const landing = liftLandingMesh(core);
    for (const level of it.levels) {
      const m = this.meshOf(landing, this.material);
      m.position.y = level.y;
      this.scene.add(m);
      this.landings.push(m);
    }
  }

  /**
   * The letters on the board over the core's mouth: a canvas texture on a
   * plane, one per level, so a player at the end of the hallway can read
   * "LIFT" -- the owner's *"clearly saying lift"*. The green board itself is
   * in the interior mesh; this is only the word, transparent around it.
   */
  private rebuildSigns(it: Interior): void {
    for (const m of this.signs) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as MeshBasicNodeMaterial).dispose();
    }
    this.signs = [];
    for (const s of liftSignsOf(it)) {
      let tex = this.signTextures.get(s.text);
      if (tex === undefined) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (ctx === null) continue;
        ctx.clearRect(0, 0, 256, 64);
        ctx.fillStyle = '#f2ead6';
        ctx.font = 'bold 46px system-ui, Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s.text, 128, 34);
        tex = new CanvasTexture(canvas);
        this.signTextures.set(s.text, tex);
      }
      const material = new MeshBasicNodeMaterial();
      material.map = tex;
      material.transparent = true;
      material.depthWrite = false;
      const mesh = new Mesh(new PlaneGeometry(s.half * 2, s.height), material);
      mesh.position.set(s.x, s.y, s.z);
      mesh.lookAt(s.x + s.nx, s.y, s.z + s.nz);
      mesh.layers.set(INTERIOR_LAYER);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.userData.unclipped = true;
      this.scene.add(mesh);
      this.signs.push(mesh);
    }
  }

  rebuild(it: Interior, door: InteriorDoor = it.door): void {
    this.rebuildCab(it);
    const old = this.mesh;
    if (old !== null) {
      this.scene.remove(old);
      old.geometry.dispose();
      this.mesh = null;
    }
    this.rebuildSigns(it);
    const built = interiorMesh(it, door);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(built.colors, 3));
    const mesh = new Mesh(geometry, this.material);
    mesh.layers.set(INTERIOR_LAYER);
    // Never culled. The bounding sphere would be right, and a room the player is
    // *standing in* is never off screen -- so the test is a per-frame cost that
    // can only ever answer yes, and a wrong `computeBoundingSphere` on a buffer
    // built this frame is a room that vanishes at the door.
    mesh.frustumCulled = false;
    // Nothing else is on this layer, so there is nothing to sort against.
    mesh.renderOrder = 0;
    mesh.userData.unclipped = true;
    this.scene.add(mesh);
    this.mesh = mesh;
  }

  /**
   * Show the customiser's preview here, or nowhere.
   *
   * Rebuilt rather than moved, because a couch is seven boxes whose *shape*
   * changes with its quarter turn -- a transform on a mesh would have to carry
   * the turn as a rotation and would then be a second place the turn is
   * expressed. A hundred and twenty triangles a frame is nothing.
   */
  setGhost(it: Interior | null, at: Placement | null, ok: boolean): void {
    const old = this.ghost;
    if (old !== null) {
      this.scene.remove(old);
      old.geometry.dispose();
      this.ghost = null;
    }
    if (it === null || at === null) return;
    const built = ghostMesh(it, at, ok);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(built.colors, 3));
    const mesh = new Mesh(geometry, this.material);
    mesh.layers.set(INTERIOR_LAYER);
    mesh.frustumCulled = false;
    // Over the room, so a preview standing against a wall is not half-eaten by
    // it: the two are millimetres apart and the depth test has no opinion worth
    // having about which should win.
    mesh.renderOrder = 1;
    mesh.userData.unclipped = true;
    this.scene.add(mesh);
    this.ghost = mesh;
  }

  /** Take it away, and put the camera back on the city. */
  hide(camera: Camera): void {
    camera.layers.set(0);
    this.setGhost(null, null, false);
    this.dropCab();
    this.setWorldHole(null);
    for (const m of this.signs) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as MeshBasicNodeMaterial).dispose();
    }
    this.signs = [];
    const mesh = this.mesh;
    if (mesh === null) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.mesh = null;
  }
}
