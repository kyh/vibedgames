// The start screen teaches the controls for the device in hand: keys and
// mouse on a desktop, thumbs on a phone, a controller only while one is
// plugged in. Rendered from the same manifest the pause overlay uses, one
// short strip per input method so the eye finds "aim" next to "shoot".

import { controlGroups, watchControlContext } from "@repo/embed";
import type { ControlMethod, ControlsManifest } from "@repo/embed";

const chip = (input: string): string =>
  input
    .split(" / ")
    .map((key) => `<kbd>${key}</kbd>`)
    .join(" / ");

const render = (
  target: HTMLElement,
  manifest: ControlsManifest,
  labels: Record<ControlMethod, string>,
): void => {
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
): (() => void) => {
  render(target, manifest, labels);
  return watchControlContext(() => render(target, manifest, labels));
};
