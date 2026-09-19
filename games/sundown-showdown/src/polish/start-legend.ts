// The start screen teaches the controls for the device in hand: keys and
// mouse on a desktop, thumbs on a phone, a controller only while one is
// plugged in. Rendered from the same manifest the pause overlay uses.

import { controlHints, watchControlContext } from "@repo/embed";
import type { ControlsManifest } from "@repo/embed";

const chip = (input: string): string =>
  input
    .split(" / ")
    .map((key) => `<kbd>${key}</kbd>`)
    .join(" / ");

const render = (target: HTMLElement, manifest: ControlsManifest): void => {
  target.innerHTML = controlHints(manifest)
    .map(([input, action]) => `<span class="legend-row">${chip(input)} ${action}</span>`)
    .join("");
};

/** Fill `target` with the device-filtered legend and keep it current. Returns a disposer. */
export const mountStartLegend = (target: HTMLElement, manifest: ControlsManifest): (() => void) => {
  render(target, manifest);
  return watchControlContext(() => render(target, manifest));
};
