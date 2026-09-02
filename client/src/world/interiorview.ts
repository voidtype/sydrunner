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
import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  type Scene,
} from 'three/webgpu';
import { ghostMesh, interiorMesh, type Interior } from './interior.ts';
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

  constructor(private readonly scene: Scene) {}

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
  show(camera: Camera, it: Interior): void {
    this.hide(camera);
    this.rebuild(it);
    camera.layers.set(INTERIOR_LAYER);
  }

  /**
   * Rebuild the room's triangles in place, keeping the camera where it is.
   *
   * Called when somebody furnishes the building. Separate from `show` because
   * `show` is also the thing that takes the camera off the city, and doing that
   * again every time a couch lands would be a layer switch per placement for no
   * reason -- and would fight anything that had legitimately changed it.
   */
  rebuild(it: Interior): void {
    const old = this.mesh;
    if (old !== null) {
      this.scene.remove(old);
      old.geometry.dispose();
      this.mesh = null;
    }
    const built = interiorMesh(it);
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
    this.scene.add(mesh);
    this.ghost = mesh;
  }

  /** Take it away, and put the camera back on the city. */
  hide(camera: Camera): void {
    camera.layers.set(0);
    this.setGhost(null, null, false);
    const mesh = this.mesh;
    if (mesh === null) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.mesh = null;
  }
}
