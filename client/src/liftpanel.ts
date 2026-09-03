/**
 * The lift's floor panel: the column of floors a rider chooses from.
 *
 * The owner: *"When in a lift i should be able to choose floor and it travels
 * there."* `E` in the cab opens it, `W`/`S` (or the arrows) move the pick,
 * `E` again sends `MSG.LIFT` with the floor, `Esc` closes it. Drawn in the
 * Harbour Steel system (UI.md): a steel panel with a sandstone rule, the
 * floors as Jost labels top-down the way a real panel reads, the pick in
 * sandstone, the floor you are on marked. Pure DOM, no state of its own:
 * `main.ts` owns the pick and calls `show` every frame the panel is up.
 */
export interface LiftFloor {
  level: number;
  name: string;
}

export class LiftPanel {
  private readonly root: HTMLElement | null;
  private readonly list: HTMLElement | null;
  private shownKey = '';

  constructor() {
    this.root = typeof document === 'undefined' ? null : document.getElementById('lift');
    this.list = typeof document === 'undefined' ? null : document.getElementById('lift-list');
  }

  show(floors: readonly LiftFloor[], current: number, pick: number): void {
    if (this.root === null || this.list === null) return;
    const key = `${floors.length}:${current}:${pick}`;
    if (key === this.shownKey && !this.root.hidden) return;
    this.shownKey = key;
    this.list.replaceChildren();
    for (let i = floors.length - 1; i >= 0; i--) {
      const f = floors[i];
      const li = document.createElement('li');
      li.textContent = f.name;
      if (f.level === pick) li.classList.add('pick');
      if (f.level === current) li.classList.add('here');
      this.list.appendChild(li);
    }
    this.root.hidden = false;
  }

  hide(): void {
    if (this.root === null) return;
    this.root.hidden = true;
    this.shownKey = '';
  }

  get visible(): boolean {
    return this.root !== null && !this.root.hidden;
  }
}
