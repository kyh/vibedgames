// Floating damage / pickup numbers: a fixed pool of DOM nodes recycled in
// round-robin order, each rising from a world position for a short life.

export interface Floater {
  /** Horizontal drift in px over the full life, random per spawn. */
  drift: number;
  el: HTMLElement;
  /** Seconds left; 0 means the node is parked and hidden. */
  life: number;
  x: number;
  y: number;
  z: number;
}

export const FLOATER_LIFE = 0.85;

export const createFloaters = (layer: HTMLElement, count: number): Floater[] => {
  const floaters: Floater[] = [];
  for (let i = 0; i < count; i += 1) {
    const el = document.createElement("div");
    el.className = "floater";
    el.hidden = true;
    layer.append(el);
    floaters.push({ drift: 0, el, life: 0, x: 0, y: 0, z: 0 });
  }
  return floaters;
};

export const spawnFloater = (
  floater: Floater,
  x: number,
  y: number,
  z: number,
  text: string,
  className: string,
): void => {
  floater.life = FLOATER_LIFE;
  floater.x = x + (Math.random() - 0.5) * 0.5;
  floater.y = y;
  floater.z = z;
  floater.drift = (Math.random() - 0.5) * 30;
  floater.el.textContent = text;
  floater.el.className = `floater ${className}`;
  floater.el.hidden = false;
};

/** Pop in over the first 15% of life, settle, then fade over the last 30%. */
export const styleFloater = (
  floater: Floater,
  screenX: number,
  screenY: number,
  progress: number,
): void => {
  const scale =
    progress < 0.15
      ? 0.6 + (progress / 0.15) * 0.6
      : 1.2 - Math.min(1, (progress - 0.15) * 1.5) * 0.2;
  const x = (screenX + floater.drift * progress).toFixed(1);
  floater.el.style.transform = `translate3d(${x}px, ${screenY.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(2)})`;
  floater.el.style.opacity = progress > 0.7 ? ((1 - progress) / 0.3).toFixed(2) : "1";
};
