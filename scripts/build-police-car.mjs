#!/usr/bin/env node
/**
 * The NSW Police highway-patrol sedan, built from nothing by this file.
 *
 * Every other `.glb` in `client/public/cars/` arrived from Sketchfab or Poly
 * Pizza and was normalised by `scripts/prep-car-models.mjs`. This one has no
 * source. The owner, 2026-09: *"the cars are fucked renmake aussie cop cars nsw
 * from scratch"* -- and the car being replaced is `police_kenney.glb`, a 2,304
 * triangle toy from a free kit whose whole police-ness was that somebody named
 * the file that. It is white, it is a car, and there is nothing on it that says
 * NSW Police, because the kit it came from has no livery: the marked look was
 * being carried entirely by `world/cars.chequerBand`, a ring of alternating
 * quads the box fleet scales around the outside of the body.
 *
 * There is no free model of a current NSW Police Force Highway Patrol car with
 * a licence this project can ship, and there was never going to be. So the car
 * is *authored*, here, in a script that is committed and re-runnable:
 *
 *     export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
 *     node scripts/build-police-car.mjs
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT RATHER THAN A CHECKED-IN BINARY.
 *
 * The `.glb` is checked in as well -- it has to be, the client fetches it -- but
 * a binary nobody can regenerate is a binary nobody can change. A police car is
 * a thing this project will keep having opinions about (the chequer's pitch, the
 * lettering, where the bar sits), and every one of those opinions is a two-line
 * diff here and an unreviewable 60 kB blob otherwise. The rule this file holds
 * itself to is therefore **the same bytes twice**: nothing hashed off a clock,
 * nothing iterated over an unordered map, no randomness at all. Run it on a
 * clean tree and `git status` is empty.
 *
 * ---------------------------------------------------------------------------
 * THE CONVENTION, which is read from the renderer rather than assumed.
 *
 *   - **+X is the nose, +Y is up, +Z is the car's right.** `world/cars.ts`'s
 *     `Station` doc: a rotation of `heading` about Y sends +X to
 *     `(cos h, 0, -sin h)`. `world/carlod.YAW_CORRECTION` is *empty* and its
 *     note says why -- the prep owns the nose, one fact in one place -- so a
 *     file that arrives here nose-down-`-X` is a file that renders backwards
 *     forever. This one is authored the right way round and never corrected.
 *   - **Origin at the footprint centre in X/Z, tyres at y = 0.** `carlod`
 *     re-grounds a model whose lowest vertex is not at zero, but only after
 *     complaining; this one lands there by construction.
 *   - **4.90 x 1.85 x 1.45 m** plus the bar. That is a full-size Australian
 *     highway-patrol sedan, and it is 20 cm longer than `bodyLimits('police')`'s
 *     4.70 -- which is fine and is checked: `carlod` refuses a model on width and
 *     height against `PROPORTION_LIMIT` and never on length, because a marked
 *     car is drawn on whichever of the five bodies the timetable rolled and no
 *     single length could agree with all of them.
 *
 * ---------------------------------------------------------------------------
 * ONE TEXTURE, AND WHY THE LIVERY IS PAINTED RATHER THAN MODELLED.
 *
 * `carlod.mergeModel` collapses every model to **one** geometry and **one**
 * material, and its shader is one line: the atlas texel times the vertex colour,
 * with the entity's paint taking over wherever the prep's `_PAINT` mask is on.
 * Two things fall out of that and they decide the whole build:
 *
 *   - the Battenburg and the lettering cannot be geometry with their own
 *     material, because there is no second material downstream. They are
 *     **texels**, in one 1024 x 512 atlas painted here with `sharp` out of an
 *     SVG this file writes -- the same tool and the same trick `prep-car-models`
 *     uses to pack a Sketchfab car's dozen maps into one.
 *   - `_PAINT` is **0 on every vertex**. The manifest row is `tint: "none"`
 *     (`world/carlod.ts` section 6 names this file as the one that is), so the
 *     mask would be forced off anyway -- but writing it means
 *     `scripts/render-car-sheet.mjs` draws the car in its own colours instead of
 *     washing the whole thing in the sheet's diagnostic blue, and the sheet is
 *     the only pair of eyes this asset gets before a deploy.
 *
 * The chequer's blue is `world/cars.LIVERY_CHEQUER_BLUE` and its white is
 * `LIVERY_CHEQUER_WHITE`, converted out of the linear triples that file holds
 * into the sRGB bytes a `baseColorTexture` is decoded from. **One force wears
 * one livery**: the band the box fleet draws around a distant marked car, the
 * band on an officer's chest in `world/police.ts`, and the chequer baked into
 * this car's flanks are the same two colours, and they are the same two colours
 * because all three derive from one pair of numbers rather than from three
 * people's idea of police blue.
 *
 * ---------------------------------------------------------------------------
 * THE TWO FLANKS ARE TWO RECTANGLES, AND THAT IS NOT A WASTE.
 *
 * The obvious economy is one flank strip sampled from both sides. It writes
 * "POLICE" on the driver's door and "ECILOP" on the passenger's, because the two
 * sides of a car are mirror images and text is not. So the atlas carries the
 * strip twice -- once laid out nose-right for the +Z flank, once nose-left for
 * the -Z flank -- with the *artwork* mirrored between them and the *lettering*
 * drawn upright in both. The second strip is half the atlas and it is 60 kB of
 * flat-colour PNG either way; a mirrored word is forever.
 *
 * ---------------------------------------------------------------------------
 * THE LIGHT BAR IS ITS OWN GEOMETRY AND THE LIGHT IS NOT IN THIS FILE.
 *
 * The bar is three boxes -- a dark housing and two lenses, red over the left half
 * and blue over the right -- on their own primitives with their own emissive
 * materials, so anything that opens this file sees a lamp where a lamp is. What
 * it is **not** is the flash: `carlod` throws the emissive away with the
 * materials, and a bar that pulsed by having its own shader would be a pipeline
 * of its own on a fleet that has two. The flash and the two real lights a
 * pursuing car borrows live in `world/nightlights.ts`, on the additive-sprite
 * path every other lamp in this game is drawn with, and this geometry is what
 * they sit on. An ambient marked car parked outside a station has a dark bar,
 * which is what one looks like.
 */

import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'client/public/cars');
const OUT_FILE = 'nsw_police.glb';
const args = process.argv.slice(2);
const atlasArg = args.indexOf('--atlas-png');
/** `--atlas-png <path>`: also write the painted atlas out on its own, for looking at. */
const ATLAS_OUT = atlasArg >= 0 ? args[atlasArg + 1] : null;

// --- The car, in metres --------------------------------------------------------------

/** Overall. The bar adds another 9 cm above `ROOF`; see `LIGHT_BAR`. */
const LENGTH = 4.9;
const WIDTH = 1.85;
const ROOF = 1.45;
const HALF_L = LENGTH / 2;
const HALF_W = WIDTH / 2;

/**
 * The lower body, as cross-sections along X from tail to nose.
 *
 * `hw` is the half-width at that station, `ylo` the bottom of the sheet metal
 * (the sill between the wheels, the valance at the ends) and `yhi` the deck --
 * boot lid, beltline, bonnet. The greenhouse is a second loft that sits on top
 * of it, and the two overlap by 6 cm rather than meeting exactly, because a seam
 * that has to be exact is a seam that opens the first time somebody retunes one
 * number.
 *
 * **The shell stops at +/- 2.40 and the car is 4.90 long**, and the 5 cm at each
 * end is where the grille, the head lamps, the tail lamps and the plate live.
 * The first cut ran the sheet metal all the way to 2.45 and set the fittings
 * flush into it, which put the grille's front face exactly on the nose's own
 * surface: two coplanar sheets and no depth between them, drawn as a row of dark
 * slivers across the bumper that looked like the bonnet had been keyed. A lamp
 * is a thing that sticks out of a car; giving it somewhere to stick out of is
 * cheaper than fighting the z-buffer.
 */
const BODY_STATIONS = [
  { x: -2.4, hw: 0.76, ylo: 0.4, yhi: 0.98 },
  { x: -2.3, hw: 0.85, ylo: 0.37, yhi: 1.0 },
  { x: -1.95, hw: 0.905, ylo: 0.31, yhi: 1.045 },
  { x: -1.45, hw: HALF_W, ylo: 0.29, yhi: 1.06 },
  { x: -0.7, hw: HALF_W, ylo: 0.28, yhi: 1.065 },
  { x: 0.15, hw: HALF_W, ylo: 0.28, yhi: 1.065 },
  { x: 0.95, hw: 0.915, ylo: 0.29, yhi: 1.05 },
  { x: 1.6, hw: 0.9, ylo: 0.31, yhi: 1.0 },
  { x: 2.15, hw: 0.855, ylo: 0.35, yhi: 0.94 },
  { x: 2.34, hw: 0.8, ylo: 0.38, yhi: 0.88 },
  { x: 2.4, hw: 0.74, ylo: 0.42, yhi: 0.82 },
];

/**
 * The greenhouse: rear glass, roof, windscreen, as an arch per station.
 *
 * `ylo` is 1.00 for every one of them -- inside the body, deliberately -- so the
 * canopy's open bottom is never visible from any angle a player stands at. The
 * roof span is stations 2..4; the segment before it is the rear glass and the
 * one after is the windscreen, and that is a *span index* rather than a normal
 * test because a 34-degree windscreen faces mostly upward and any threshold on
 * the normal that admitted the roof admitted it too.
 */
const CANOPY_STATIONS = [
  { x: -1.72, hw: 0.55, ylo: 1.0, yhi: 1.08 },
  { x: -1.35, hw: 0.72, ylo: 1.0, yhi: 1.3 },
  { x: -0.88, hw: 0.78, ylo: 1.0, yhi: 1.43 },
  { x: -0.15, hw: 0.785, ylo: 1.0, yhi: ROOF },
  { x: 0.45, hw: 0.78, ylo: 1.0, yhi: 1.44 },
  { x: 0.62, hw: 0.77, ylo: 1.0, yhi: 1.42 },
  { x: 1.15, hw: 0.63, ylo: 1.0, yhi: 1.06 },
];
/**
 * The stretch of the canopy whose upper faces are roof rather than glass.
 *
 * A *range in X* and not a normal test, because a 34-degree windscreen faces
 * mostly upward and every threshold on the normal that admitted the roof
 * admitted the screen with it -- which paints the windscreen white and gives the
 * car a bonnet where its glass should be.
 */
const ROOF_X = [-0.88, 0.62];

/**
 * How finely the shell is tessellated, and why it is not as coarse as it could
 * be -- which is no longer the reason this file first gave.
 *
 * A twelve-sided section and the eleven stations above draw a perfectly good
 * car: 800 triangles, the silhouette right, the wheels right. The first cut of
 * this file subdivided it to 32 facets and `MAX_STATION_GAP` **to make the
 * livery legible on the contact sheet**, because `scripts/render-car-sheet.mjs`
 * shaded one colour per triangle from its three corners' texels and a flank
 * quad averaged a whole Battenburg cell into one grey.
 *
 * That was chasing a fault in the picture with geometry on the car, and it
 * could never have worked: the letters of "POLICE" have a 4 cm stroke, and no
 * tessellation a 5 m car can afford resolves 4 cm. The sheet now samples the
 * atlas per fragment, exactly as `carlod.materialFor`'s shader does, and the
 * livery is crisp there at 800 triangles or 2,700.
 *
 * The subdivision stays anyway, and on its own merits: `carlod` is the one
 * material in this build that is not flat-shaded, so the shell is drawn with
 * smooth normals, and a twelve-sided superellipse smooth-shaded is a melted
 * Kenney car. 2,700 triangles against a 10,283-triangle Prado and a
 * 20,387-triangle X-Trail is still the cheapest real car in the manifest.
 */
const BODY_SIDES = 32;
const ARCH_POINTS = 16;
const WHEEL_SIDES = 12;
const MAX_STATION_GAP = 0.17;

/**
 * The section shape: a superellipse, so a car is a rounded box rather than a
 * tube. 0.62 is boxy enough that the flanks are flat where the doors are --
 * which is what makes the painted chequer sit on a surface instead of wrapping
 * round one -- and round enough that the facets do not crowd into the corners
 * and leave the door with two rows of quads on it.
 */
const SECTION_POWER = 0.62;
const ARCH_POWER = 0.62;

/** Wheels: where they sit, how big, how wide. Track 1.61 m inside a 1.85 m body. */
const WHEEL_R = 0.335;
const WHEEL_HALF = 0.105;
/** Where the tyre's sidewall stops and the hub starts, as a fraction of the radius. */
const HUB_SHARE = 0.55;
const WHEEL_X = [-1.45, 1.45];
const WHEEL_Z = 0.8;

/** The bar: a dark housing across the roof and two lenses on it. */
const LIGHT_BAR = {
  x: 0.02,
  housingY: 1.42,
  housingHalf: [0.165, 0.055, 0.5],
  lensY: 1.505,
  lensHalf: [0.14, 0.035, 0.235],
  lensZ: 0.25,
};

// --- The atlas -----------------------------------------------------------------------

/**
 * 2048 x 1024, and the doubling is paid for on the flanks.
 *
 * The first cut was 1024 x 512, which gave the flank strip 209 x 191 px/m and
 * a 4 cm letter stroke seven pixels wide. That is legible in the atlas and it
 * was **not** legible on the car: a texel that is 5 mm of real door is a texel
 * the mip chain throws away by the time a player is ten metres off, and the
 * only place a marked car is ever read at ten metres is the only place it
 * matters -- the far side of an intersection, which is where you decide whether
 * to run. At 2048 x 1024 the flank is 418 x 417 px/m, square to within a
 * pixel per metre, and "POLICE" is 400 px of atlas rather than 200.
 *
 * The cost is 6.5 kB, and that number is the argument. Four times the texels of
 * a flat-colour PNG is not four times the bytes -- 3.7 kB became 10.2 kB, and
 * the `.glb` went from 363.1 kB to 369.8 kB, which is 1.8% on the one car in
 * the fleet whose whole purpose is to be recognised before it is close. Nearly
 * all of this file is its 4,240 triangles; the livery is a rounding error.
 */
const ATLAS_W = 2048;
const ATLAS_H = 1024;

/**
 * Where each painted surface lives in the atlas, in pixels.
 *
 * The two flank strips get the atlas's full width and three quarters of its
 * height between them -- 384 rows each -- because the flank is what a player
 * sees. They cover the same 4.90 x 0.92 m window on the car at 418 x 417
 * px/m, which is square texels to within a pixel per metre: a Battenburg cell
 * is as crisp along the car as it is up it, and the letter strokes do not come
 * out fatter one way than the other.
 *
 * The bonnet, the boot and the twelve flat-colour cells share the 256 rows
 * left at the bottom, which is far more than any of them needs: a boot lid is
 * eight rectangles and a solid cell is one colour.
 */
const FLANK_R = { x: 0, y: 0, w: ATLAS_W, h: 384 };
const FLANK_L = { x: 0, y: 384, w: ATLAS_W, h: 384 };
const BONNET = { x: 0, y: 768, w: 704, h: 224 };
const BOOT = { x: 704, y: 768, w: 704, h: 224 };

/** The world window each flank strip covers. */
const FLANK_Y0 = 0.2;
const FLANK_Y1 = 1.12;

/**
 * The Battenburg's grid, in world metres on the flank.
 *
 * Twelve columns of 0.39 m over two rows of 0.165, so a cell is about what a
 * real one is and the band runs 0.375 to 0.705 -- between the sill and the door
 * handles, inside the stretch where the section is genuinely flat (0.37 to 0.97,
 * see `SECTION_POWER`), so the grid sits on a surface instead of wrapping round
 * one.
 *
 * The band was 0.26 m tall in the first cut and it read as one row of blocks
 * rather than as a chequer. A Battenburg's whole legibility is that the eye
 * gets *two* rows to see the half-offset in; one row of alternating blocks is a
 * Sillitoe band, which is a thing that goes on a cap.
 *
 * Here rather than inside the painter because the *loft* reads it too: the body
 * has section cuts either side of every column boundary. See `resample`.
 */
const CHEQUER = { x0: -2.34, cols: 12, cellW: 4.68 / 12, y0: 0.375, rowH: 0.165 };
/** ...and the bonnet's and the boot's, in X and in Z. */
const BONNET_X = [1.15, 2.2];
const BONNET_Z = 0.8;
const BOOT_X = [-2.3, -1.55];
const BOOT_Z = 0.75;

/** The flat-colour cells, 80 px square, two rows down the right of the atlas. */
const SOLID_ORIGIN = [1424, 768];
const SOLID_CELL = 80;
const SOLID_PER_ROW = 7;

/**
 * The palette, as sRGB bytes -- which is what a `baseColorTexture` is, and is
 * therefore where the conversion from the renderer's linear triples happens.
 *
 * `chequerBlue` and `chequerWhite` are `world/cars.ts`'s `LIVERY_CHEQUER_BLUE`
 * and `LIVERY_CHEQUER_WHITE` run through `srgb()` below, and `bodyWhite` is
 * `CAR_LIVERY_WHITE` -- which is `PAINT[0]`, the same white a civilian car is
 * painted, deliberately: the thing that marks a police car is the chequer and
 * not a whiter white. Everything else is judged here.
 */
const linear = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055));
const srgb = (t) => `rgb(${linear(t[0])},${linear(t[1])},${linear(t[2])})`;
const PALETTE = {
  // `sky/carpaint.CAR_PAINT_ALBEDO[0]`, which is where `CAR_LIVERY_WHITE` now
  // comes from. It moved from 0.805 in 2026-09 when the palette was re-derived
  // against the clearcoat, which is two sRGB code values here (232 -> 234) --
  // so the shipped `nsw_police.glb` is two values under the fleet until this
  // script is next run, and that is a rebuild rather than a deploy.
  bodyWhite: srgb([0.825550, 0.829009, 0.824876]),
  chequerBlue: srgb([0.05, 0.14, 0.44]),
  chequerWhite: srgb([0.82, 0.85, 0.88]),
  tyre: 'rgb(34,34,36)',
  hub: 'rgb(96,98,102)',
  glass: 'rgb(41,46,54)',
  grille: 'rgb(26,26,28)',
  headlamp: 'rgb(142,164,186)',
  taillamp: 'rgb(178,22,26)',
  lensRed: 'rgb(220,26,30)',
  lensBlue: 'rgb(34,54,222)',
  under: 'rgb(30,30,32)',
  trim: 'rgb(52,54,58)',
  arch: 'rgb(28,28,30)',
};

/** The solid cells, in the order they are laid out. `cellUv` finds one by name. */
const SOLID_NAMES = [
  'bodyWhite', 'tyre', 'hub', 'glass', 'grille', 'headlamp', 'taillamp',
  'lensRed', 'lensBlue', 'under', 'trim', 'arch',
];

function cellRect(name) {
  const i = SOLID_NAMES.indexOf(name);
  if (i < 0) throw new Error(`no solid cell named ${name}`);
  const x = SOLID_ORIGIN[0] + (i % SOLID_PER_ROW) * SOLID_CELL;
  const y = SOLID_ORIGIN[1] + Math.floor(i / SOLID_PER_ROW) * SOLID_CELL;
  return { x, y, w: SOLID_CELL, h: SOLID_CELL };
}

/** The centre of a solid cell, in UV. Every flat surface on the car points here. */
function cellUv(name) {
  const r = cellRect(name);
  return [(r.x + r.w / 2) / ATLAS_W, (r.y + r.h / 2) / ATLAS_H];
}

// --- The lettering -------------------------------------------------------------------

/**
 * "POLICE", drawn as rectangles rather than as text.
 *
 * `sharp` renders SVG through librsvg and would happily set a font -- but which
 * font, at what weight, is a property of the machine the script ran on, and this
 * file's one promise is the same bytes twice. Six glyphs of five strokes each is
 * forty lines, is a stencil face (which is what is actually on the side of a
 * highway-patrol car), and has no dependency at all. The em box is 0.62 wide by
 * 1.0 tall with a stroke of 0.2, and the advance is 0.8.
 */
const GLYPHS = {
  P: [[0, 0, 0.2, 1], [0, 0, 0.62, 0.2], [0, 0.4, 0.62, 0.2], [0.42, 0, 0.2, 0.6]],
  O: [[0, 0, 0.62, 0.2], [0, 0.8, 0.62, 0.2], [0, 0, 0.2, 1], [0.42, 0, 0.2, 1]],
  L: [[0, 0, 0.2, 1], [0, 0.8, 0.62, 0.2]],
  I: [[0.21, 0, 0.2, 1]],
  C: [[0, 0, 0.62, 0.2], [0, 0.8, 0.62, 0.2], [0, 0, 0.2, 1]],
  E: [[0, 0, 0.2, 1], [0, 0, 0.62, 0.2], [0, 0.4, 0.62, 0.2], [0, 0.8, 0.62, 0.2]],
};
const GLYPH_ADVANCE = 0.8;

/** The width of a word at unit height, for centring it. */
function wordWidth(text) {
  return text.length * GLYPH_ADVANCE - (GLYPH_ADVANCE - 0.62);
}

/**
 * A word as SVG rectangles, its left edge at `x`, its top at `y`, `h` tall.
 * `sx` stretches it horizontally, for the bonnet, where the letters are wide.
 */
function word(text, x, y, h, colour, sx = 1) {
  const out = [];
  let pen = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`no glyph for "${ch}"`);
    for (const [gx, gy, gw, gh] of glyph) {
      out.push(
        `<rect x="${(pen + gx * h * sx).toFixed(2)}" y="${(y + gy * h).toFixed(2)}" ` +
          `width="${(gw * h * sx).toFixed(2)}" height="${(gh * h).toFixed(2)}" fill="${colour}"/>`,
      );
    }
    pen += GLYPH_ADVANCE * h * sx;
  }
  return out;
}

// --- Painting the atlas ---------------------------------------------------------------

/**
 * One flank, as SVG elements inside its own rectangle.
 *
 * `mirror` lays the car out nose-left instead of nose-right, which is what the
 * -Z side needs (see the header): every element's position is reflected and
 * every letter is still drawn the right way round.
 *
 * The Battenburg is two rows of half-offset cells, which is what the pattern
 * *is* -- a single row of alternating blocks is a Sillitoe band and belongs on a
 * cap, not on a car -- and it sits between the sill and the door handles, where
 * a real one does. The lettering goes above it, in the chequer's own blue.
 */
function flankArt(rect, mirror) {
  const px = (x) => {
    const f = (x + HALF_L) / LENGTH;
    return rect.x + (mirror ? 1 - f : f) * rect.w;
  };
  const py = (y) => rect.y + ((FLANK_Y1 - y) / (FLANK_Y1 - FLANK_Y0)) * rect.h;
  const sx = rect.w / LENGTH;
  const sy = rect.h / (FLANK_Y1 - FLANK_Y0);
  const out = [`<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="${PALETTE.bodyWhite}"/>`];

  /*
   * The sill, dark, along the bottom of the strip.
   *
   * There is no wheel arch cut in the geometry -- an arch is a hole, and a hole
   * in a lofted section is twenty more quads on a car that is 800 triangles.
   * What replaces it is this: the sheet metal's own lower edge is at y = 0.28
   * and the tyres run from 0 to 0.67, so the bottom band of every flank is the
   * rocker panel in the car's own shadow with a black tyre under each end of it.
   * Painting that band dark is what makes the tyres read as sitting *in* the car
   * rather than beside it, and it costs one rectangle.
   *
   * The first cut of this painted two dark ellipses at the wheel stations
   * instead. They were 88 px tall inside a 176 px strip, they were mostly below
   * the window the strip covers so all that showed was a flat slab, and -- the
   * part worth remembering -- SVG does not clip a shape to the rectangle you
   * meant it for, so the lower strip's ellipses ran on down the atlas and
   * painted over four of the solid cells. Every region is clipped now.
   */
  out.push(
    `<rect x="${rect.x}" y="${py(0.36).toFixed(2)}" width="${rect.w}" ` +
      `height="${((0.36 - FLANK_Y0) * sy).toFixed(2)}" fill="${PALETTE.arch}"/>`,
  );

  /*
   * The Battenburg: twelve columns of two rows over 4.68 m of flank.
   *
   * It sits between 0.375 and 0.705, inside the band where the section is
   * genuinely flat (0.37 to 0.97 -- see `SECTION_POWER`), because a chequer that
   * ran up onto the shoulder is a chequer wrapping round a curve and the whole
   * point of the pattern is that it is a grid. The cell is 0.39 x 0.165, which
   * is about what a real one is; see `CHEQUER` on why the band got taller.
   */
  {
    for (let c = 0; c < CHEQUER.cols; c++) {
      for (let r = 0; r < 2; r++) {
        // The half-offset: the two rows are opposite, which is the checker.
        const blue = ((c + r) & 1) === 0;
        const ax = px(CHEQUER.x0 + c * CHEQUER.cellW);
        const bx = px(CHEQUER.x0 + (c + 1) * CHEQUER.cellW);
        const lo = CHEQUER.y0 + r * CHEQUER.rowH;
        out.push(
          `<rect x="${Math.min(ax, bx).toFixed(2)}" y="${py(lo + CHEQUER.rowH).toFixed(2)}" ` +
            `width="${Math.abs(bx - ax).toFixed(2)}" height="${(CHEQUER.rowH * sy).toFixed(2)}" ` +
            `fill="${blue ? PALETTE.chequerBlue : PALETTE.chequerWhite}"/>`,
        );
      }
    }
  }

  /*
   * "POLICE" on the doors, above the chequer and under the glass.
   *
   * 0.22 m of cap height over 1.17 m of door, which is about what is on the
   * real car and is the number the atlas was doubled for: at 417 px/m that is a
   * 92 px letter with an 18 px stroke, drawn into the atlas at full size rather
   * than drawn small and resampled up. A stencil stroke this heavy survives the
   * mip chain, which a hairline does not -- and the thing being bought is not
   * the word on the contact sheet, it is the word at ten metres in the game.
   */
  {
    const h = 0.22 * sy;
    const w = wordWidth('POLICE') * h * 1.15;
    out.push(...word('POLICE', px(0) - w / 2, py(0.98), h, PALETTE.chequerBlue, 1.15));
  }
  return out;
}

/** The bonnet: white, with the word across it reading from in front of the car. */
function bonnetArt() {
  const out = [`<rect x="${BONNET.x}" y="${BONNET.y}" width="${BONNET.w}" height="${BONNET.h}" fill="${PALETTE.bodyWhite}"/>`];
  const h = BONNET.h * 0.4;
  const stretch = 1.7;
  const w = wordWidth('POLICE') * h * stretch;
  out.push(...word('POLICE', BONNET.x + (BONNET.w - w) / 2, BONNET.y + BONNET.h * 0.36, h, PALETTE.chequerBlue, stretch));
  return out;
}

/** The boot lid: the chequer straight across it, four columns by two rows. */
function bootArt() {
  const out = [`<rect x="${BOOT.x}" y="${BOOT.y}" width="${BOOT.w}" height="${BOOT.h}" fill="${PALETTE.bodyWhite}"/>`];
  const cols = 4;
  const rows = 2;
  const cw = BOOT.w / cols;
  const rh = (BOOT.h * 0.72) / rows;
  const y0 = BOOT.y + BOOT.h * 0.14;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const blue = ((c + r) & 1) === 0;
      out.push(
        `<rect x="${(BOOT.x + c * cw).toFixed(2)}" y="${(y0 + r * rh).toFixed(2)}" ` +
          `width="${cw.toFixed(2)}" height="${rh.toFixed(2)}" ` +
          `fill="${blue ? PALETTE.chequerBlue : PALETTE.chequerWhite}"/>`,
      );
    }
  }
  return out;
}

/**
 * Every region's artwork, fenced inside the region.
 *
 * SVG has no notion of "this belongs to that rectangle" -- a shape whose bounds
 * run past the rect you drew it in simply paints over whatever is next door,
 * which is how the first cut of the flanks got two wheel-arch ellipses over the
 * solid colour cells and a car with a black headlight. Four `clipPath`s cost
 * nothing and make an atlas region a region.
 */
function clipped(id, rect, elements) {
  return (
    `<clipPath id="${id}"><rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}"/></clipPath>` +
    `<g clip-path="url(#${id})">${elements.join('')}</g>`
  );
}

async function paintAtlas() {
  const parts = [`<rect width="${ATLAS_W}" height="${ATLAS_H}" fill="${PALETTE.bodyWhite}"/>`];
  parts.push(clipped('flankR', FLANK_R, flankArt(FLANK_R, false)));
  parts.push(clipped('flankL', FLANK_L, flankArt(FLANK_L, true)));
  parts.push(clipped('bonnet', BONNET, bonnetArt()));
  parts.push(clipped('boot', BOOT, bootArt()));
  for (const name of SOLID_NAMES) {
    const r = cellRect(name);
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${PALETTE[name]}"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ATLAS_W}" height="${ATLAS_H}">${parts.join('')}</svg>`;
  // PNG rather than the prep's JPEG: this atlas is flat colour and hard edges,
  // which is the one case where a lossy codec both looks worse and compresses
  // worse. 1024 x 512 of it is under 30 kB.
  return await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer();
}

// --- The mesh ---------------------------------------------------------------------------

/**
 * A triangle accumulator, on `world/police.Parts`' shape.
 *
 * Positions, normals, UVs and one scalar `_PAINT` per vertex, with a vertex per
 * corner per quad -- unshared, because every quad chooses its own patch of the
 * atlas and a shared vertex cannot be in two of them. The *normals* are supplied
 * by the caller rather than derived per face, so a lofted flank can be smooth
 * even though its vertices are not shared: see `loft`.
 */
class Parts {
  constructor() {
    this.position = [];
    this.normal = [];
    this.uv = [];
    this.index = [];
  }

  /** One quad, wound `a -> b -> c -> d`, with a normal and a UV per corner. */
  quad(pts, normals, uvs) {
    const base = this.position.length / 3;
    for (let i = 0; i < 4; i++) {
      this.position.push(pts[i][0], pts[i][1], pts[i][2]);
      this.normal.push(normals[i][0], normals[i][1], normals[i][2]);
      this.uv.push(uvs[i][0], uvs[i][1]);
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A flat quad: one face normal for all four corners, one UV for all four. */
  flat(a, b, c, d, uv) {
    const n = faceNormal(a, b, c);
    this.quad([a, b, c, d], [n, n, n, n], [uv, uv, uv, uv]);
  }

  /** An axis-aligned box in one flat colour. Six quads, all wound outward. */
  box(centre, half, uv) {
    const [cx, cy, cz] = centre;
    const [hx, hy, hz] = half;
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;
    this.flat([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], uv);
    this.flat([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], uv);
    this.flat([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], uv);
    this.flat([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], uv);
    this.flat([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], uv);
    this.flat([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], uv);
  }

  get triangles() {
    return this.index.length / 3;
  }
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

const signPow = (v, p) => (v < 0 ? -Math.pow(-v, p) : Math.pow(v, p));

/**
 * The station table with intermediate sections cut into it, so no gap along the
 * car is longer than `MAX_STATION_GAP`.
 *
 * Linear between the authored stations and nowhere else: the shape is the eleven
 * numbers above and this only decides how many rings stand between them. A
 * spline here would move the silhouette without anybody having asked it to.
 */
function resample(stations, maxGap, cuts = []) {
  const lerp = (a, b, f) => ({
    x: a.x + (b.x - a.x) * f,
    hw: a.hw + (b.hw - a.hw) * f,
    ylo: a.ylo + (b.ylo - a.ylo) * f,
    yhi: a.yhi + (b.yhi - a.yhi) * f,
  });
  const out = [stations[0]];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1];
    const b = stations[i];
    // Every forced cut inside this gap, in order, and then the gap's own even
    // subdivision between each pair of them.
    const inside = cuts.filter((c) => c > Math.min(a.x, b.x) + 1e-6 && c < Math.max(a.x, b.x) - 1e-6).sort((p, q) => (b.x > a.x ? p - q : q - p));
    let from = a;
    for (const c of [...inside, b.x]) {
      const target = c === b.x ? b : lerp(a, b, (c - a.x) / (b.x - a.x));
      const steps = Math.max(1, Math.ceil(Math.abs(target.x - from.x) / maxGap));
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        out.push({
          x: from.x + (target.x - from.x) * f,
          hw: from.hw + (target.hw - from.hw) * f,
          ylo: from.ylo + (target.ylo - from.ylo) * f,
          yhi: from.yhi + (target.yhi - from.yhi) * f,
        });
      }
      from = target;
    }
  }
  return out;
}

/** A closed body section: a superellipse in (z, y) at one station. */
function sectionRing(station) {
  const mid = (station.ylo + station.yhi) / 2;
  const halfH = (station.yhi - station.ylo) / 2;
  const out = [];
  for (let k = 0; k < BODY_SIDES; k++) {
    const a = (k / BODY_SIDES) * Math.PI * 2;
    out.push([
      station.x,
      mid + halfH * signPow(Math.sin(a), SECTION_POWER),
      station.hw * signPow(Math.cos(a), SECTION_POWER),
    ]);
  }
  return out;
}

/** An open canopy arch: +hw over the top to -hw, both ends at `ylo`. */
function archRing(station) {
  const out = [];
  for (let k = 0; k < ARCH_POINTS; k++) {
    const a = (k / (ARCH_POINTS - 1)) * Math.PI;
    out.push([
      station.x,
      station.ylo + (station.yhi - station.ylo) * Math.pow(Math.abs(Math.sin(a)), ARCH_POWER),
      station.hw * signPow(Math.cos(a), ARCH_POWER),
    ]);
  }
  return out;
}

/**
 * Smooth normals for a grid of ring points, by accumulating the faces round each.
 *
 * The reason this exists at all rather than every quad taking its own face
 * normal: `carlod` is the one material in this build that is **not**
 * flat-shaded ("these carry authored normals"), so a body whose normals are
 * per-face is drawn faceted, and a twelve-sided car section faceted is a Kenney
 * car -- which is the thing this file is replacing.
 */
function smoothNormals(rings, closed) {
  const acc = rings.map((r) => r.map(() => [0, 0, 0]));
  const kMax = closed ? rings[0].length : rings[0].length - 1;
  for (let s = 0; s < rings.length - 1; s++) {
    for (let k = 0; k < kMax; k++) {
      const k1 = (k + 1) % rings[0].length;
      const n = faceNormal(rings[s][k], rings[s + 1][k], rings[s + 1][k1]);
      for (const [si, ki] of [[s, k], [s, k1], [s + 1, k], [s + 1, k1]]) {
        acc[si][ki][0] += n[0];
        acc[si][ki][1] += n[1];
        acc[si][ki][2] += n[2];
      }
    }
  }
  for (const ring of acc) {
    for (const n of ring) {
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      n[0] /= len;
      n[1] /= len;
      n[2] /= len;
    }
  }
  return acc;
}

/** The +Z flank's UV for a point, and the -Z flank's. See the header on the two strips. */
function flankUv(x, y, rightSide) {
  const rect = rightSide ? FLANK_R : FLANK_L;
  const f = (x + HALF_L) / LENGTH;
  const u = rect.x + (rightSide ? f : 1 - f) * rect.w;
  const v = rect.y + ((FLANK_Y1 - Math.min(FLANK_Y1, Math.max(FLANK_Y0, y))) / (FLANK_Y1 - FLANK_Y0)) * rect.h;
  return [u / ATLAS_W, v / ATLAS_H];
}

/**
 * The bonnet's UV, laid out so the word reads to somebody standing in front of
 * the car: screen-right from there is -Z, and screen-up is -X.
 */
function bonnetUv(x, z) {
  const u = BONNET.x + ((BONNET_Z - z) / (2 * BONNET_Z)) * BONNET.w;
  const f = (x - BONNET_X[0]) / (BONNET_X[1] - BONNET_X[0]);
  const v = BONNET.y + Math.min(1, Math.max(0, f)) * BONNET.h;
  return [u / ATLAS_W, v / ATLAS_H];
}

/** The boot lid's. A chequer has no reading direction, so this is the plain one. */
function bootUv(x, z) {
  const u = BOOT.x + ((z + BOOT_Z) / (2 * BOOT_Z)) * BOOT.w;
  const f = (x - BOOT_X[0]) / (BOOT_X[1] - BOOT_X[0]);
  const v = BOOT.y + Math.min(1, Math.max(0, f)) * BOOT.h;
  return [u / ATLAS_W, v / ATLAS_H];
}

/**
 * Which patch of the atlas a lower-body quad takes, from where it points.
 *
 * The dominant axis of the face normal decides: sideways is a flank, up is a
 * deck (and which deck is a question about X), down is the underbody, and along
 * the car is a bumper. A quad on the shoulder -- the round between the flank and
 * the deck -- lands on whichever is larger and is painted white at the top of
 * the flank strip either way, so the seam does not show.
 */
function bodyQuadUv(pts) {
  const n = faceNormal(pts[0], pts[1], pts[2]);
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) {
    if (n[1] < 0) return pts.map(() => cellUv('under'));
    const xm = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
    if (xm >= BONNET_X[0]) return pts.map((p) => bonnetUv(p[0], p[2]));
    if (xm <= BOOT_X[1]) return pts.map((p) => bootUv(p[0], p[2]));
    return pts.map(() => cellUv('bodyWhite'));
  }
  if (az >= ax) {
    const zm = (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4;
    return pts.map((p) => flankUv(p[0], p[1], zm >= 0));
  }
  return pts.map(() => cellUv('bodyWhite'));
}

/** The lower body and the greenhouse, lofted station to station. */
function buildShell(parts) {
  // --- The lower body: a closed loft, capped at both ends.
  {
    /*
     * Cut extra rings either side of every Battenburg column boundary.
     *
     * This was written to fight the contact sheet's old per-triangle shading,
     * and the honest note is that it never won: it aligned the *columns* to
     * triangle edges, but the chequer's two *rows* fall wherever the
     * superellipse's own facet ring happens to land -- a ring is at y = 0.530
     * and the row boundary was placed at 0.53 to match it, and then the band's
     * top edge at 0.66 sat inside a quad that ran to 0.6725 and smeared anyway.
     * A pattern is only as crisp as its worst edge.
     *
     * The sheet samples per fragment now and the whole argument is moot. The
     * cuts stay because they cost 24 rings and even out the flank's shading
     * where the section changes width fastest, which is at the doors -- and
     * because removing them would change the triangle count in
     * `client/public/cars/manifest.json` for no gain a person can see.
     */
    const cuts = [];
    for (let c = 0; c <= CHEQUER.cols; c++) {
      const b = CHEQUER.x0 + c * CHEQUER.cellW;
      cuts.push(b - CHEQUER.cellW / 8, b + CHEQUER.cellW / 8);
    }
    const stations = resample(BODY_STATIONS, MAX_STATION_GAP, cuts);
    const rings = stations.map(sectionRing);
    const normals = smoothNormals(rings, true);
    for (let s = 0; s < rings.length - 1; s++) {
      for (let k = 0; k < BODY_SIDES; k++) {
        const k1 = (k + 1) % BODY_SIDES;
        const pts = [rings[s][k], rings[s + 1][k], rings[s + 1][k1], rings[s][k1]];
        const nrm = [normals[s][k], normals[s + 1][k], normals[s + 1][k1], normals[s][k1]];
        parts.quad(pts, nrm, bodyQuadUv(pts));
      }
    }
    // The caps: a fan to the section's own centre, wound outward at each end.
    for (const [index, outward] of [[0, -1], [rings.length - 1, 1]]) {
      const ring = rings[index];
      const st = stations[index];
      const centre = [st.x, (st.ylo + st.yhi) / 2, 0];
      const n = [outward, 0, 0];
      const uv = cellUv('bodyWhite');
      for (let k = 0; k < BODY_SIDES; k++) {
        const k1 = (k + 1) % BODY_SIDES;
        const a = outward > 0 ? ring[k1] : ring[k];
        const b = outward > 0 ? ring[k] : ring[k1];
        parts.quad([centre, a, b, centre], [n, n, n, n], [uv, uv, uv, uv]);
      }
    }
  }

  // --- The greenhouse.
  {
    const stations = resample(CANOPY_STATIONS, MAX_STATION_GAP);
    const rings = stations.map(archRing);
    const normals = smoothNormals(rings, false);
    for (let s = 0; s < rings.length - 1; s++) {
      const xm = (stations[s].x + stations[s + 1].x) / 2;
      const roofSpan = xm >= ROOF_X[0] && xm <= ROOF_X[1];
      for (let k = 0; k < ARCH_POINTS - 1; k++) {
        const pts = [rings[s][k], rings[s + 1][k], rings[s + 1][k + 1], rings[s][k + 1]];
        const nrm = [normals[s][k], normals[s + 1][k], normals[s + 1][k + 1], normals[s][k + 1]];
        const n = faceNormal(pts[0], pts[1], pts[2]);
        const uv = roofSpan && n[1] > 0.6 ? cellUv('bodyWhite') : cellUv('glass');
        parts.quad(pts, nrm, [uv, uv, uv, uv]);
      }
    }
    // The two ends, closed against the beltline so the canopy is not a tunnel.
    for (const [index, outward] of [[0, -1], [rings.length - 1, 1]]) {
      const ring = rings[index];
      const st = stations[index];
      const centre = [st.x, st.ylo, 0];
      const n = [outward, 0, 0];
      const uv = cellUv('glass');
      for (let k = 0; k < ARCH_POINTS - 1; k++) {
        const a = outward > 0 ? ring[k + 1] : ring[k];
        const b = outward > 0 ? ring[k] : ring[k + 1];
        parts.quad([centre, a, b, centre], [n, n, n, n], [uv, uv, uv, uv]);
      }
    }
  }
}

/** Four black wheels with a grey hub on the outside face. */
function buildWheels(parts) {
  const tyre = cellUv('tyre');
  const hub = cellUv('hub');
  for (const x of WHEEL_X) {
    for (const side of [-1, 1]) {
      const zc = WHEEL_Z * side;
      const zo = zc + WHEEL_HALF * side;
      const zi = zc - WHEEL_HALF * side;
      const ring = [];
      for (let k = 0; k < WHEEL_SIDES; k++) {
        const a = (k / WHEEL_SIDES) * Math.PI * 2;
        ring.push([x + Math.cos(a) * WHEEL_R, WHEEL_R + Math.sin(a) * WHEEL_R]);
      }
      for (let k = 0; k < WHEEL_SIDES; k++) {
        const k1 = (k + 1) % WHEEL_SIDES;
        const [ax, ay] = ring[k];
        const [bx, by] = ring[k1];
        // Wound so the tread faces out of the cylinder, whichever side it is on.
        const a0 = [ax, ay, zi], a1 = [bx, by, zi], b1 = [bx, by, zo], b0 = [ax, ay, zo];
        const quad = side > 0 ? [a0, a1, b1, b0] : [b0, b1, a1, a0];
        const na = [(ax - x) / WHEEL_R, (ay - WHEEL_R) / WHEEL_R, 0];
        const nb = [(bx - x) / WHEEL_R, (by - WHEEL_R) / WHEEL_R, 0];
        // The tread's normal is radial and the same either way round the loop;
        // only the winding differs, which is what the two orders above are.
        const nrm = side > 0 ? [na, nb, nb, na] : [nb, na, na, nb];
        parts.quad(quad, nrm, [tyre, tyre, tyre, tyre]);
      }
      /*
       * The outer face: a black sidewall ring with a grey hub inside it, not one
       * grey disc. The inner face is never seen from anywhere a player stands
       * and is not emitted at all.
       *
       * The first cut drew the whole face in the hub colour, and every wheel on
       * the contact sheet came out mid-grey -- because from three quarters on,
       * the disc is most of what you see of a wheel and the tread is a sliver.
       * A car with four grey wheels reads as a car up on stands. `HUB_SHARE` is
       * where the tyre stops.
       */
      const nOut = [0, 0, side];
      const centre = [x, WHEEL_R, zo];
      const inner = ring.map(([rx, ry]) => [x + (rx - x) * HUB_SHARE, WHEEL_R + (ry - WHEEL_R) * HUB_SHARE]);
      for (let k = 0; k < WHEEL_SIDES; k++) {
        const k1 = (k + 1) % WHEEL_SIDES;
        const a = [ring[k][0], ring[k][1], zo];
        const b = [ring[k1][0], ring[k1][1], zo];
        const ia = [inner[k][0], inner[k][1], zo];
        const ib = [inner[k1][0], inner[k1][1], zo];
        const wall = side > 0 ? [ia, a, b, ib] : [ib, b, a, ia];
        parts.quad(wall, [nOut, nOut, nOut, nOut], [tyre, tyre, tyre, tyre]);
        const face = side > 0 ? [centre, ia, ib, centre] : [centre, ib, ia, centre];
        parts.quad(face, [nOut, nOut, nOut, nOut], [hub, hub, hub, hub]);
      }
    }
  }
}

/** The lamps, the grille and the mirrors: everything bolted to the shell. */
function buildFittings(parts) {
  // Head lamps, either side of the grille, in the 5 cm the shell leaves them.
  // They reach 0.68 either side against a nose cap that is 0.67 wide at their
  // own height, so they wrap the corner by a centimetre, which is what a lamp
  // on a modern car does and what stops the nose reading as a slab.
  for (const side of [-1, 1]) {
    parts.box([2.42, 0.7, 0.48 * side], [0.03, 0.055, 0.2], cellUv('headlamp'));
  }
  // The grille, dark, on the nose's flat.
  parts.box([2.43, 0.6, 0], [0.02, 0.09, 0.36], cellUv('grille'));
  // Tail lamps.
  for (const side of [-1, 1]) {
    parts.box([-2.43, 0.85, 0.52 * side], [0.02, 0.085, 0.2], cellUv('taillamp'));
  }
  // Mirrors, on the A pillar's shoulder. Two boxes each, so they read as a
  // mirror rather than as a blob: an arm and a glass.
  //
  // Their outer face is at 0.923, a fraction inside the body's own half-width,
  // and that is a *measurement* rather than styling: `WIDTH` is what the car is,
  // and a pair of mirrors sticking 8 cm past it made the file 2.06 m wide, which
  // is what `carlod.PROPORTION_LIMIT` is there to catch and what the boot of the
  // parked car beside it would be inside of. Mirrors are still visible because
  // nothing else on the car reaches that far out at 1.10 m: the sheet metal has
  // ended at the beltline and the glasshouse is 15 cm narrower.
  for (const side of [-1, 1]) {
    parts.box([0.82, 1.09, 0.855 * side], [0.055, 0.045, 0.045], cellUv('trim'));
    parts.box([0.78, 1.1, 0.895 * side], [0.075, 0.055, 0.028], cellUv('glass'));
  }
  // The rear number plate, which is twelve triangles of "this is a car".
  parts.box([-2.42, 0.58, 0], [0.02, 0.075, 0.19], cellUv('bodyWhite'));
}

/** The bar's housing. The two lenses are their own primitives; see `buildLenses`. */
function buildBarHousing(parts) {
  parts.box([LIGHT_BAR.x, LIGHT_BAR.housingY, 0], LIGHT_BAR.housingHalf, cellUv('trim'));
}

function buildLens(parts, side, cell) {
  parts.box([LIGHT_BAR.x, LIGHT_BAR.lensY, LIGHT_BAR.lensZ * side], LIGHT_BAR.lensHalf, cellUv(cell));
}

// --- Writing the file ------------------------------------------------------------------

function primitive(doc, buffer, parts, material) {
  const prim = doc.createPrimitive().setMaterial(material);
  prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(parts.position)).setBuffer(buffer));
  prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(parts.normal)).setBuffer(buffer));
  prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(parts.uv)).setBuffer(buffer));
  // The prep's mask, off everywhere. See the header: this car's colours are its
  // own and the entity's paint never lands on it.
  prim.setAttribute('_PAINT', doc.createAccessor().setType('SCALAR').setArray(new Float32Array(parts.position.length / 3)).setBuffer(buffer));
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(parts.index)).setBuffer(buffer));
  return prim;
}

async function main() {
  const atlas = await paintAtlas();
  if (ATLAS_OUT) {
    fs.mkdirSync(path.dirname(ATLAS_OUT), { recursive: true });
    fs.writeFileSync(ATLAS_OUT, atlas);
    console.log(`wrote ${ATLAS_OUT} (${(atlas.byteLength / 1024).toFixed(1)} kB)`);
  }

  const doc = new Document();
  doc.createBuffer();
  const buffer = doc.getRoot().listBuffers()[0];
  const texture = doc.createTexture('nsw_police_atlas').setImage(atlas).setMimeType('image/png');

  const bodyMat = doc
    .createMaterial('nsw_police_body')
    .setBaseColorTexture(texture)
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.45)
    .setAlphaMode('OPAQUE')
    .setDoubleSided(false);
  const shell = new Parts();
  buildShell(shell);
  buildWheels(shell);
  buildFittings(shell);
  buildBarHousing(shell);

  const red = new Parts();
  buildLens(red, -1, 'lensRed');
  const blue = new Parts();
  buildLens(blue, 1, 'lensBlue');

  /*
   * The two lenses carry the atlas as well, and that is not decoration.
   *
   * `carlod.mergeModel` takes the **first** map it finds across the whole file
   * and samples it for every vertex of the merged geometry -- so a lens material
   * with no map would still be read against the atlas, at whatever UV it
   * happened to carry, which for a fresh primitive is (0, 0). Giving both lenses
   * the same texture and a UV into their own solid cell is what makes that
   * one-map assumption true rather than merely survived. The emissive factor is
   * the honest description of a lamp for anything that opens this file; the
   * renderer throws it away with the materials, and the flash is
   * `world/nightlights.PoliceBeacons`.
   */
  const redMat = doc
    .createMaterial('nsw_police_lightbar_red')
    .setBaseColorTexture(texture)
    .setBaseColorFactor([1, 1, 1, 1])
    .setEmissiveFactor([1, 0.04, 0.04])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.25)
    .setDoubleSided(false);
  const blueMat = doc
    .createMaterial('nsw_police_lightbar_blue')
    .setBaseColorTexture(texture)
    .setBaseColorFactor([1, 1, 1, 1])
    .setEmissiveFactor([0.05, 0.12, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.25)
    .setDoubleSided(false);

  const mesh = doc.createMesh('nsw_police');
  mesh.addPrimitive(primitive(doc, buffer, shell, bodyMat));
  mesh.addPrimitive(primitive(doc, buffer, red, redMat));
  mesh.addPrimitive(primitive(doc, buffer, blue, blueMat));

  const node = doc.createNode('nsw_police').setMesh(mesh);
  doc.createScene('nsw_police').addChild(node);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, OUT_FILE);
  const glb = await new NodeIO().writeBinary(doc);
  fs.writeFileSync(outPath, Buffer.from(glb));

  // --- Read it back and measure it, per `prep-car-models`' rule: never trust
  // the in-memory Document, and never trust the numbers at the top of the file.
  const written = await new NodeIO().read(outPath);
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (const m of written.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      const idx = p.getIndices();
      tris += (idx ? idx.getCount() : pos.getCount()) / 3;
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], v[a]);
          hi[a] = Math.max(hi[a], v[a]);
        }
      }
    }
  }
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const problems = [];
  if (Math.abs(lo[1]) > 0.002) problems.push(`the lowest vertex is at y = ${lo[1].toFixed(4)}, not on the road`);
  if (Math.abs(lo[0] + hi[0]) > 0.002) problems.push(`the origin is ${((lo[0] + hi[0]) / 2).toFixed(4)} m off centre along X`);
  if (Math.abs(lo[2] + hi[2]) > 0.002) problems.push(`the origin is ${((lo[2] + hi[2]) / 2).toFixed(4)} m off centre along Z`);
  if (!(size[0] > size[2])) problems.push('the car is wider than it is long; the nose is not on +X');
  if (size[1] > 1.7) problems.push(`it is ${size[1].toFixed(2)} m tall, over the police body box's own 1.70`);

  console.log(`${OUT_FILE}: ${tris} triangles, ${(glb.byteLength / 1024).toFixed(1)} kB`);
  console.log(`  extent ${size[0].toFixed(3)} x ${size[1].toFixed(3)} x ${size[2].toFixed(3)} m, lowest y ${lo[1].toFixed(4)}`);
  console.log(`  atlas ${ATLAS_W} x ${ATLAS_H} PNG, ${(atlas.byteLength / 1024).toFixed(1)} kB`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`ERROR: ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
