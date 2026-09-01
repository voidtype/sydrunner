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
import { interiorMesh, type Interior } from './interior.ts';

/**
 * The layer an interior is drawn on, and the city is not.
 *
 * 1 rather than 0, because 0 is what every object in three is born on and is
 * therefore the city by definition. Nothing else in this project uses a layer,
 * which is what makes this safe: the switch is total.
 */
export const INTERIOR_LAYER = 1;

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

  constructor(private readonly scene: Scene) {}

  /** Is an interior currently being drawn? */
  get active(): boolean {
    return this.mesh !== null;
  }

  /**
   * Draw this building's inside, and point the camera at it alone.
   *
   * The door is passed rather than taken off the interior, for the reason the
   * interior has no door: it is per entrant, and it is drawn on the wall so the
   * way out is visible from inside.
   */
  show(
    camera: Camera,
    it: Interior,
    doorX: number,
    doorZ: number,
    doorNX: number,
    doorNZ: number,
  ): void {
    this.hide(camera);
    const built = interiorMesh(it, doorX, doorZ, doorNX, doorNZ);
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
    camera.layers.set(INTERIOR_LAYER);
  }

  /** Take it away, and put the camera back on the city. */
  hide(camera: Camera): void {
    camera.layers.set(0);
    const mesh = this.mesh;
    if (mesh === null) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.mesh = null;
  }
}
