/** Queried once from the live renderer, before the city starts building. */
export type RenderCapabilities = { readonly multiDraw: boolean };

let current: RenderCapabilities = { multiDraw: false };

export function setRenderCapabilities(capabilities: RenderCapabilities): void {
  current = { multiDraw: capabilities.multiDraw };
}

export function renderCapabilities(): RenderCapabilities {
  return current;
}
