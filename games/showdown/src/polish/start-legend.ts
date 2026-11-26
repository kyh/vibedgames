import { controlGroups, watchControlContext } from "@repo/embed";
import type { ControlMethod, ControlsManifest } from "@repo/embed";

const chip = (input: string) =>
  input
    .split(" / ")
    .map((key) => `<kbd>${key}</kbd>`)
    .join(" / ");

const render = (
  target: HTMLElement,
  manifest: ControlsManifest,
  labels: Record<ControlMethod, string>,
) => {
  target.innerHTML = controlGroups(manifest)
    .map((group) => {
      const rows = group.entries
        .map((entry) => `<span class="legend-row">${chip(entry.input)} ${entry.action}</span>`)
        .join("");

      return `<span class="legend-group"><b>${labels[group.method]}</b>${rows}</span>`;
    })
    .join("");
};

/** Fill `target` with the device-filtered legend and keep it current. Returns a disposer. */
export const mountStartLegend = (
  target: HTMLElement,
  manifest: ControlsManifest,
  labels: Record<ControlMethod, string>,
) => {
  render(target, manifest, labels);

  return watchControlContext(() => {
    render(target, manifest, labels);
  });
};
