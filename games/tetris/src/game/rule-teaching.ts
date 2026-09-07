import { teachingExamples } from "./teaching-examples";

/** Three optional rule cards; one DOM owner, no gameplay state or clock. */
export class RuleTeaching {
  private readonly examples = teachingExamples();
  private index = 0;
  private painted = -1;
  private disposed = false;
  private readonly title: HTMLElement | null;
  private readonly body: HTMLElement | null;
  private readonly hint: HTMLElement | null;
  private readonly count: HTMLElement | null;
  private readonly previous: HTMLButtonElement | null;
  private readonly next: HTMLButtonElement | null;
  private readonly cells: SVGRectElement[] = [];

  constructor(private readonly root: HTMLElement | null) {
    if (!root) {
      this.title = this.body = this.hint = this.count = this.previous = this.next = null;
      return;
    }
    const doc = root.ownerDocument;
    const content = doc.createElement("div");
    content.className = "rule-content";
    const grid = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    grid.setAttribute("viewBox", "0 0 81 81");
    grid.setAttribute("aria-hidden", "true");
    for (let z = 0; z < 8; z++) {
      for (let x = 0; x < 8; x++) {
        const cell = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
        cell.setAttribute("x", String(x * 10 + 0.5));
        cell.setAttribute("y", String(z * 10 + 0.5));
        cell.setAttribute("width", "9");
        cell.setAttribute("height", "9");
        grid.append(cell);
        this.cells.push(cell);
      }
    }
    const copy = doc.createElement("div");
    copy.className = "rule-copy";
    copy.setAttribute("aria-live", "polite");
    this.title = doc.createElement("strong");
    this.body = doc.createElement("p");
    this.hint = doc.createElement("p");
    this.hint.className = "view-hint";
    copy.append(this.title, this.body, this.hint);
    content.append(grid, copy);
    const navigation = doc.createElement("div");
    navigation.className = "rule-navigation";
    this.previous = doc.createElement("button");
    this.previous.type = "button";
    this.previous.textContent = "←";
    this.previous.setAttribute("aria-label", "Previous rule");
    this.count = doc.createElement("span");
    this.count.className = "rule-count";
    this.next = doc.createElement("button");
    this.next.type = "button";
    this.next.textContent = "→";
    this.next.setAttribute("aria-label", "Next rule");
    navigation.append(this.previous, this.count, this.next);
    root.replaceChildren(content, navigation);
    root.setAttribute("aria-label", "Spatial rules");
    this.previous.addEventListener("click", this.onPrevious);
    this.next.addEventListener("click", this.onNext);
    for (const event of ["pointerdown", "pointerup", "pointermove", "pointercancel", "click"])
      root.addEventListener(event, this.sealPointer);
    root.addEventListener("keydown", this.sealActivation);
    root.addEventListener("keyup", this.sealActivation);
    this.refresh();
  }

  private readonly onPrevious = (): void => {
    if (this.disposed || this.index === 0) return;
    this.index--;
    this.refresh();
  };

  private readonly onNext = (): void => {
    if (this.disposed || this.index >= this.examples.length - 1) return;
    this.index++;
    this.refresh();
  };

  private readonly sealPointer = (event: Event): void => event.stopPropagation();
  private readonly sealActivation = (event: Event): void => {
    if (event instanceof KeyboardEvent && (event.code === "Space" || event.key === "Enter"))
      event.stopPropagation();
  };

  /** Repeated scene/control-context refresh does not replace nodes or rewrite the grid. */
  refresh(): void {
    if (this.disposed || this.painted === this.index) return;
    const example = this.examples[this.index];
    if (!example) return;
    this.painted = this.index;
    if (this.title) this.title.textContent = example.title;
    if (this.body) this.body.textContent = example.body;
    if (this.hint) this.hint.textContent = example.hint;
    if (this.count) this.count.textContent = `${this.index + 1} / ${this.examples.length}`;
    if (this.previous) this.previous.disabled = this.index === 0;
    if (this.next) this.next.disabled = this.index === this.examples.length - 1;
    this.cells.forEach((cell, index) => {
      const x = index % 8;
      const z = Math.floor(index / 8);
      const occupied = example.cells.some((c) => c.x === x && c.z === z);
      const landing = example.landing.some((c) => c.x === x && c.z === z);
      cell.setAttribute(
        "class",
        `rule-cell${occupied ? (example.clear ? " rule-cell-clear" : " rule-cell-locked") : ""}${landing ? " rule-cell-landing" : ""}`,
      );
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.previous?.removeEventListener("click", this.onPrevious);
    this.next?.removeEventListener("click", this.onNext);
    for (const event of ["pointerdown", "pointerup", "pointermove", "pointercancel", "click"])
      this.root?.removeEventListener(event, this.sealPointer);
    this.root?.removeEventListener("keydown", this.sealActivation);
    this.root?.removeEventListener("keyup", this.sealActivation);
    this.root?.replaceChildren();
    this.cells.length = 0;
  }
}
