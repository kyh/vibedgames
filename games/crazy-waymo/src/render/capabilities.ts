/** Queried once from the live renderer, before the city starts building. */
export interface RenderCapabilities {
  readonly multiDraw: boolean;
}

let current: RenderCapabilities = { multiDraw: false };

export const setRenderCapabilities = (capabilities: RenderCapabilities): void => {
  current = { multiDraw: capabilities.multiDraw };
};

export const renderCapabilities = (): RenderCapabilities => current;
