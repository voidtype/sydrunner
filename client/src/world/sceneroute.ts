/**
 * Where a thing added to the scene actually goes, and how it comes back out.
 *
 * The world lives in one `ClippingGroup` and the room does not. While a body is
 * inside a building, `InteriorView.setWorldHole` gives that group the
 * building's shell as clipping planes, and everything the city draws --
 * terrain, trees, bins, pedestrians, the odd parked car -- stops drawing inside
 * the footprint. That is the owner's canopy-through-the-ceiling on York Street,
 * fixed. But a camera, a light, the interior's own meshes, your own body and
 * the nameplates must *not* be cut, so they stay on the scene root.
 *
 * `main.ts` used to do this by patching `scene.add` and `scene.remove` in
 * place, which is the right idea: every caller in a very large file goes on
 * saying `scene.add(x)` and the routing is one decision in one spot. It lives
 * here instead because the `remove` half was wrong for two months in a way no
 * check could see, and a patch nobody can construct in a test is a patch nobody
 * can test.
 *
 * ---------------------------------------------------------------------------
 * ## The bug this file was extracted for
 *
 * The old removal was one line:
 *
 *     scene.remove = (...objects) => { for (const o of objects) o.removeFromParent(); ... }
 *
 * and `Object3D.removeFromParent` is, in three's own words, `parent.remove(this)`.
 * So for anything whose parent *is the scene* -- every camera, every light,
 * everything flagged `unclipped` -- that call went straight back into the
 * override, which called `removeFromParent` again, and the two bounced until
 * the stack ran out: **`RangeError: Maximum call stack size exceeded`**, thrown
 * out of `verifyNightLights` at boot, which adds a light to a scene and takes
 * it away again.
 *
 * It survived because the common case is safe. An object inside the clipping
 * group has `parent === world`, and `world.remove` is three's own method rather
 * than this one, so the bounce terminates on the first hop. Only the root-level
 * minority -- the lights -- could reach it, and only a caller that removed one.
 *
 * The fix is to stop asking the object to remove itself and to name the parent
 * doing the removing: three's own `remove`, taken off the scene *before* the
 * patch and bound, for a root-level object, and the group's own uninterposed
 * `remove` for everything else. Nothing recurses because nothing calls back
 * into the patched method.
 *
 * ## Why not simply drop the patch
 *
 * Because the alternative is every one of a few hundred `scene.add` calls in
 * `main.ts` choosing between two parents at the call site, which is the same
 * decision made in a few hundred places instead of one -- and the day somebody
 * adds a light to the world group is the day the interior clips the sun.
 */

import { Group, Object3D, PerspectiveCamera, PointLight, Scene } from 'three';

/** What this needs of a scene: three's `Scene`, and a test's stand-in. */
export interface SceneLike {
  add: (...objects: Object3D[]) => SceneLike;
  remove: (...objects: Object3D[]) => SceneLike;
}

/**
 * Whether an object belongs on the scene root rather than in the clipped world.
 *
 * Cameras and lights by their own flags, and anything that has said so with
 * `userData.unclipped` -- the interior's meshes, the local body, the
 * nameplates. Exported because it is the whole of the policy and a check should
 * assert the policy rather than a re-statement of it.
 */
export function staysUnclipped(o: Object3D): boolean {
  const probe = o as { isCamera?: boolean; isLight?: boolean };
  return probe.isCamera === true || probe.isLight === true || o.userData?.unclipped === true;
}

/**
 * Patch `scene.add` and `scene.remove` to route through `world`.
 *
 * Call once, before anything is added. `world` is added to the scene root here
 * rather than by the caller, so the one object that must never be routed is put
 * in place by the code that knows why.
 */
export function installSceneRouting(scene: Scene, world: Object3D): void {
  const addRaw = scene.add.bind(scene);
  const removeRaw = scene.remove.bind(scene);
  addRaw(world);
  scene.add = ((...objects: Object3D[]) => {
    for (const o of objects) {
      if (staysUnclipped(o)) addRaw(o);
      else world.add(o);
    }
    return scene;
  }) as typeof scene.add;
  scene.remove = ((...objects: Object3D[]) => {
    for (const o of objects) {
      const parent = o.parent;
      if (parent === null) continue;
      // **Never `o.removeFromParent()` here.** That is `parent.remove(o)`, and
      // when the parent is this scene it is *this function* -- see the header.
      if ((parent as Object3D) === (scene as unknown as Object3D)) removeRaw(o);
      else parent.remove(o);
    }
    return scene;
  }) as typeof scene.remove;
}

export function verifySceneRouting(): string[] {
  const failures: string[] = [];
  const scene = new Scene();
  const world = new Group();
  world.name = 'world';
  installSceneRouting(scene, world);

  if (world.parent !== scene) failures.push('the clipping group is not on the scene root.');

  // --- Everything ordinary is clipped; the four exceptions are not.
  {
    const plain = new Object3D();
    const flagged = new Object3D();
    flagged.userData.unclipped = true;
    const camera = new PerspectiveCamera();
    const light = new PointLight();
    scene.add(plain, flagged, camera, light);
    if (plain.parent !== world) failures.push('an ordinary object was not put in the clipping group.');
    for (const [name, o] of [['an unclipped object', flagged], ['a camera', camera], ['a light', light]] as const) {
      if (o.parent !== scene) failures.push(`${name} was clipped with the world; it belongs on the root.`);
    }
    if (!staysUnclipped(camera) || !staysUnclipped(light) || !staysUnclipped(flagged)) {
      failures.push('the policy and the routing disagree about what stays unclipped.');
    }
    if (staysUnclipped(plain)) failures.push('an ordinary object claims to be unclipped.');
    // Put the scene back as it was found, so the tally at the end is about the
    // block that made it rather than about this one.
    scene.remove(plain, flagged, camera, light);
  }

  // --- **The regression.** Removing a root-level object used to bounce between
  //     this override and `Object3D.removeFromParent` until the stack ran out.
  //     A light, because a light is what `verifyNightLights` removes and what
  //     took the boot down. If this recurses the check does not fail, it throws
  //     -- and `main.ts`'s `timed` now names it, which is how it was found.
  {
    const light = new PointLight();
    scene.add(light);
    if (light.parent !== scene) failures.push('a light did not land on the root, so the removal below proves nothing.');
    scene.remove(light);
    if (light.parent !== null) failures.push('a light removed from the scene root still has a parent.');
    if (scene.children.includes(light)) failures.push('a light removed from the scene root is still among its children.');

    const camera = new PerspectiveCamera();
    scene.add(camera);
    scene.remove(camera);
    if (camera.parent !== null) failures.push('a camera removed from the scene root still has a parent.');
  }

  // --- And the common case still works: out of the clipping group, by the
  //     group's own method, with the scene none the wiser.
  {
    const plain = new Object3D();
    scene.add(plain);
    scene.remove(plain);
    if (plain.parent !== null) failures.push('an ordinary object removed from the world still has a parent.');
    if (world.children.includes(plain)) failures.push('an ordinary object removed from the world is still in it.');
  }

  // --- An object somewhere else entirely leaves that parent, not this scene;
  //     and one with no parent at all is not an error.
  {
    const elsewhere = new Group();
    const child = new Object3D();
    elsewhere.add(child);
    scene.remove(child);
    if (child.parent !== null) failures.push('an object held by another group was not removed from it.');
    if (elsewhere.children.includes(child)) failures.push('an object was left in the group it was removed from.');
    const orphan = new Object3D();
    scene.remove(orphan);
    if (orphan.parent !== null) failures.push('removing an orphan gave it a parent.');
  }

  // --- Many at once, both kinds, in one call: the signature `main.ts` uses.
  {
    const a = new Object3D();
    const b = new PointLight();
    scene.add(a, b);
    scene.remove(a, b);
    if (a.parent !== null || b.parent !== null) failures.push('a mixed batch removal left something attached.');
    if (scene.children.length !== 1 || scene.children[0] !== world) {
      failures.push(`the scene root ended with ${scene.children.length} children; only the world group belongs there.`);
    }
    if (world.children.length !== 0) failures.push(`${world.children.length} objects were left in the clipping group.`);
  }

  return failures;
}
