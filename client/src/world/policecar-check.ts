/**
 * The six client-side self-checks this round touched, run outside a browser.
 *
 * `CLAUDE.md`: acceptance is a repeatable, cheap test. The checks that cover the
 * police car, its light bar and the officer's cap are already wired into
 * `main.ts`'s boot list -- which means they run in a tab and nowhere else. That
 * is fine for a player and useless for anybody landing a change to them, because
 * the only way to see the result is to open the game.
 *
 * Every one of them is pure: they build geometry, sweep a function and read
 * numbers off a `BufferGeometry`, and not one touches a `WebGPURenderer` or a
 * canvas. So they run perfectly well under a plain import, and this file is the
 * one line that does it:
 *
 *     export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
 *     cd client && bun run src/world/policecar-check.ts
 *
 * It prints every failure and then **throws**, which is what makes it a gate:
 * `server/accounts-check.ts`'s non-zero exit, expressed in a file that lives in
 * the client's tsconfig and therefore has no `process`. It is **not** a second
 * copy of any assertion -- everything below is a call into the check that already
 * exists, so a rule added to one of those files is a rule this runs the next time
 * somebody types the command.
 */

import { CharacterAssets } from '../player/character.ts';
import { verifyCarLabels } from '../game/carlabels.ts';
import { verifyCarVisibility } from './carvisibility-check.ts';
import { CharacterKitAssets, verifyCharacterKit } from './characters.ts';
import { verifyNightLights } from './nightlights.ts';
import { verifyParkedPool } from './parkedpool-check.ts';
import { PoliceAssets, verifyPoliceKit } from './police.ts';

const characters = new CharacterAssets();
const sections: Array<[string, string[]]> = [
  // The fleet: that the manifest's police row still names a file, that the pool
  // it is in has the length the modulus assumes, and that every car in Sydney
  // still has a name. `verifyCarLabels` also runs on the Bun server's boot list;
  // the other two are the browser's only.
  ['verifyCarLabels', verifyCarLabels()],
  ['verifyCarVisibility', verifyCarVisibility()],
  ['verifyParkedPool', verifyParkedPool()],
  ['verifyCharacterKit', verifyCharacterKit(new CharacterKitAssets(characters))],
  ['verifyPoliceKit', verifyPoliceKit(new PoliceAssets(characters))],
  // The night rig builds its own throwaway probes against a bare `Object3D`,
  // which is exactly why its constructor takes one rather than a `Scene`.
  ['verifyNightLights', verifyNightLights()],
];

let failed = 0;
for (const [name, failures] of sections) {
  if (failures.length === 0) {
    console.log(`ok   ${name}`);
    continue;
  }
  failed += failures.length;
  console.log(`FAIL ${name}`);
  for (const f of failures) console.log(`       ${f}`);
}
if (failed > 0) {
  throw new Error(`${failed} self-check failure(s); see above.`);
}
console.log('\nall green');
