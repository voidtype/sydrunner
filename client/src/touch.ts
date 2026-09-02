/**
 * Touch controls: a left-hand stick, a look pad, and four buttons.
 *
 * The owner: *"add a horizontal only control mode for mobile, just moving and
 * shooting and enter (just make enter a context button i can tap) ... On
 * screen joy is fine if thats all we can do"*. So: a virtual stick on the
 * left that moves, a pad on the right that turns you (yaw only -- the pitch
 * is locked, which is the "horizontal only"), and four buttons: bat, footy,
 * jump, and the context button, which wears whatever the prompt line says
 * ("go inside", "lift up", "take the car") and presses E.
 *
 * ---------------------------------------------------------------------------
 * IT DRIVES THE SAME INPUTS THE KEYBOARD DOES, AND NOTHING ELSE.
 *
 * The stick adds and removes `KeyW`/`KeyA`/`KeyS`/`KeyD` in the very `keys`
 * set the keydown listener writes, the look pad adds to `input.yaw` the way
 * `mousemove` does, and the bat and footy buttons call `money.mousedown` with
 * the button the mouse would have sent. There is no second input path for
 * the simulation to disagree with, no touch-specific movement code, and
 * every existing check on the keyboard path covers this one. The stick is
 * eight-way because the controller's `forward`/`right` are, which is what a
 * keyboard gives; a real analogue stick would want the controller to take a
 * magnitude, and that is a change to the simulation, not to this file.
 *
 * Shown only on a coarse pointer (`(pointer: coarse)`), which is a phone or a
 * tablet and not a laptop with a touchscreen someone never uses; on those the
 * legend and the keyboard stay. Pointer events, not touch events, so a pen
 * works and so a mouse on a tablet does.
 */

export interface TouchHost {
  keys: Set<string>;
  input: { yaw: number };
  /** The mouse-button dispatcher `main.ts` already has: 0 bat, 2 footy. */
  mousedown: (button: number) => boolean;
}

/** Radians of yaw per CSS pixel of look-pad drag. */
export const TOUCH_LOOK_RATE = 0.0045;
/** The stick's dead zone, CSS pixels, and its full throw. */
export const STICK_DEAD_PX = 10;
export const STICK_THROW_PX = 46;

export function touchWanted(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

/** Which keys an (x, y) stick offset presses. Pure, for the check. */
export function stickKeys(dx: number, dy: number): string[] {
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < STICK_DEAD_PX) return [];
  const out: string[] = [];
  // Eight-way: a direction counts when it holds more than 38% of the throw,
  // so a diagonal presses two keys and a slightly-off straight presses one.
  const t = 0.38 * d;
  if (-dy > t) out.push('KeyW');
  if (dy > t) out.push('KeyS');
  if (dx > t) out.push('KeyD');
  if (-dx > t) out.push('KeyA');
  return out;
}

export class TouchControls {
  readonly root = document.getElementById('touch')!;
  private readonly stick = document.getElementById('touch-stick')!;
  private readonly knob = document.getElementById('touch-knob')!;
  private readonly look = document.getElementById('touch-look')!;
  private readonly context = document.getElementById('touch-context')!;
  private readonly contextText = document.getElementById('touch-context-text')!;
  private stickId = -1;
  private stickOrigin = { x: 0, y: 0 };
  private held = new Set<string>();
  private lookId = -1;
  private lookLast = 0;
  private prompt = '';

  constructor(private readonly host: TouchHost) {
    this.root.hidden = false;
    document.body.classList.add('touch');
    const stop = (e: Event): void => e.preventDefault();
    this.root.addEventListener('contextmenu', stop);

    this.stick.addEventListener('pointerdown', (e) => {
      if (this.stickId >= 0) return;
      this.stickId = e.pointerId;
      this.stick.setPointerCapture(e.pointerId);
      const r = this.stick.getBoundingClientRect();
      this.stickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.moveStick(e.clientX, e.clientY);
      e.preventDefault();
    });
    this.stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      this.moveStick(e.clientX, e.clientY);
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.setHeld([]);
      this.knob.style.transform = '';
    };
    this.stick.addEventListener('pointerup', release);
    this.stick.addEventListener('pointercancel', release);

    this.look.addEventListener('pointerdown', (e) => {
      if (this.lookId >= 0) return;
      this.lookId = e.pointerId;
      this.lookLast = e.clientX;
      this.look.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      const dx = e.clientX - this.lookLast;
      this.lookLast = e.clientX;
      this.host.input.yaw -= dx * TOUCH_LOOK_RATE;
    });
    const lookUp = (e: PointerEvent): void => {
      if (e.pointerId === this.lookId) this.lookId = -1;
    };
    this.look.addEventListener('pointerup', lookUp);
    this.look.addEventListener('pointercancel', lookUp);

    const button = (id: string, down: () => void, up?: () => void): void => {
      const el = document.getElementById(id)!;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.classList.add('down');
        down();
      });
      const rel = (): void => {
        el.classList.remove('down');
        up?.();
      };
      el.addEventListener('pointerup', rel);
      el.addEventListener('pointercancel', rel);
      el.addEventListener('pointerleave', rel);
    };
    button('touch-bat', () => this.host.mousedown(0));
    button('touch-footy', () => this.host.mousedown(2));
    button('touch-jump', () => this.host.keys.add('Space'), () => this.host.keys.delete('Space'));
    button('touch-context', () => this.host.keys.add('KeyE'), () => this.host.keys.delete('KeyE'));
  }

  private moveStick(x: number, y: number): void {
    const dx = x - this.stickOrigin.x;
    const dy = y - this.stickOrigin.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const k = Math.min(1, STICK_THROW_PX / d);
    this.knob.style.transform = `translate(${(dx * k).toFixed(1)}px, ${(dy * k).toFixed(1)}px)`;
    this.setHeld(stickKeys(dx, dy));
  }

  private setHeld(next: readonly string[]): void {
    for (const k of this.held) if (!next.includes(k)) this.host.keys.delete(k);
    for (const k of next) this.host.keys.add(k);
    this.held = new Set(next);
  }

  /** What the context button says: the prompt line's verb, or nothing. */
  setPrompt(text: string): void {
    if (text === this.prompt) return;
    this.prompt = text;
    // "E — go inside" -> "go inside"; a line with no key is shown whole.
    const verb = text.replace(/^[A-Za-z0-9+]{1,9} — /, '').split('  ·  ')[0];
    this.contextText.textContent = verb;
    this.context.classList.toggle('live', text !== '');
  }
}

/** Self-check, client boot list. */
export function verifyTouch(): string[] {
  const failures: string[] = [];
  if (stickKeys(0, 0).length !== 0) failures.push('a centred stick presses a key.');
  if (stickKeys(0, -40).join() !== 'KeyW') failures.push(`straight up presses ${stickKeys(0, -40).join()}.`);
  if (stickKeys(40, 0).join() !== 'KeyD') failures.push(`straight right presses ${stickKeys(40, 0).join()}.`);
  const diag = stickKeys(30, -30);
  if (!(diag.includes('KeyW') && diag.includes('KeyD') && diag.length === 2)) failures.push(`up-right presses ${diag.join()}.`);
  if (stickKeys(5, -5).length !== 0) failures.push('the dead zone is not dead.');
  const slight = stickKeys(8, -40);
  if (slight.join() !== 'KeyW') failures.push(`a slightly-off straight presses ${slight.join()}.`);
  return failures;
}
