/**
 * The hero line, spent on the DOM: `game/arealine.ts` decides, this draws.
 *
 * Three elements it did not create -- `#hero`, `#hero-text`, `#hero-rule` --
 * and three writes a frame while a name is up: the opacity, the rule's width
 * and a slow drift upward. The split is `client/src/waypoint.ts`'s and is made
 * for its reason: everything that decides anything is one file over and is
 * pure, so the fade's shape is asserted on both boot lists and this file has
 * nothing in it a check could want.
 *
 * The drift is the one thing decided here rather than there, because it is
 * purely a matter of how the text looks: eight pixels over the line's whole
 * life, which is GTA's -- enough to read as breath, not enough to read as
 * movement. Nothing under `prefers-reduced-motion`.
 */
import type { AreaLineFrame } from './game/arealine.ts';

/** How far the name rises over its life, CSS pixels. */
const DRIFT_PX = 8;
/** The rule's full width, CSS pixels; it draws out over the rise. */
const RULE_PX = 180;

export class AreaLineView {
  private readonly root = document.getElementById('hero')!;
  private readonly text = document.getElementById('hero-text')!;
  private readonly rule = document.getElementById('hero-rule')!;
  private readonly still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private shown: string | null = null;
  private lastOpacity = -1;

  update(f: AreaLineFrame): void {
    if (f.text !== this.shown) {
      this.shown = f.text;
      this.text.textContent = f.text ?? '';
    }
    if (f.text === null) {
      if (this.lastOpacity !== 0) {
        this.root.style.opacity = '0';
        this.rule.style.width = '0px';
        this.lastOpacity = 0;
      }
      return;
    }
    const o = Math.round(f.opacity * 1000) / 1000;
    if (o !== this.lastOpacity) {
      this.root.style.opacity = String(o);
      this.lastOpacity = o;
    }
    // The rule draws out over the rise and stays; the fall takes it with the
    // opacity rather than retracting it, which would read as an undo.
    const rise = Math.min(1, f.progress * 4.6);
    this.rule.style.width = `${Math.round(rise * RULE_PX)}px`;
    this.root.style.transform = this.still ? '' : `translateY(${(-f.progress * DRIFT_PX).toFixed(1)}px)`;
  }
}
