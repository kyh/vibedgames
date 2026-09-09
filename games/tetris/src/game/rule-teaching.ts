import { teachingExamples } from "./teaching-examples";

const GRID = 8;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Three browsable rule cards on the title banner: an 8×8 floor diagram plus
 *  copy, each derived from a real Board so the numbers can't drift from play. */
export function mountRuleTeaching(root: HTMLElement): void {
  const examples = teachingExamples();
  let index = 0;

  const grid = document.createElementNS(SVG_NS, "svg");
  grid.setAttribute("viewBox", "0 0 81 81");
  grid.setAttribute("aria-hidden", "true");
  const cells: SVGRectElement[] = [];
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const cell = document.createElementNS(SVG_NS, "rect");
      cell.setAttribute("x", String(x * 10 + 0.5));
      cell.setAttribute("y", String(z * 10 + 0.5));
      cell.setAttribute("width", "9");
      cell.setAttribute("height", "9");
      grid.append(cell);
      cells.push(cell);
    }
  }

  const copy = document.createElement("div");
  copy.className = "rule-copy";
  copy.setAttribute("aria-live", "polite");
  const title = document.createElement("strong");
  const body = document.createElement("p");
  const hint = document.createElement("p");
  hint.className = "view-hint";
  copy.append(title, body, hint);

  const content = document.createElement("div");
  content.className = "rule-content";
  content.append(grid, copy);

  const navButton = (label: string, ariaLabel: string, step: number): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
    button.addEventListener("click", () => {
      index = Math.max(0, Math.min(examples.length - 1, index + step));
      paint();
    });
    return button;
  };
  const previous = navButton("←", "Previous rule", -1);
  const next = navButton("→", "Next rule", 1);
  const count = document.createElement("span");
  count.className = "rule-count";
  const navigation = document.createElement("div");
  navigation.className = "rule-navigation";
  navigation.append(previous, count, next);

  function paint(): void {
    const example = examples[index];
    if (!example) return;
    title.textContent = example.title;
    body.textContent = example.body;
    hint.textContent = example.hint;
    count.textContent = `${index + 1} / ${examples.length}`;
    previous.disabled = index === 0;
    next.disabled = index === examples.length - 1;
    cells.forEach((cell, i) => {
      const x = i % GRID;
      const z = Math.floor(i / GRID);
      const occupied = example.cells.some((c) => c.x === x && c.z === z);
      const landing = example.landing.some((c) => c.x === x && c.z === z);
      const fill = occupied ? (example.clear ? " rule-cell-clear" : " rule-cell-locked") : "";
      cell.setAttribute("class", `rule-cell${fill}${landing ? " rule-cell-landing" : ""}`);
    });
  }

  root.replaceChildren(content, navigation);
  root.setAttribute("aria-label", "Spatial rules");
  paint();
}
