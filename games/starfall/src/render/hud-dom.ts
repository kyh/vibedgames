/** DOM HUD text helpers: changed-only writes and the formatting rules for standings and death hints. */

/** 1 → "1ST", 2 → "2ND", 3 → "3RD", 4 → "4TH"… (sector standings surfaces). */
export const ordinal = (rank: number): string => {
  const mod100 = rank % 100;
  const mod10 = rank % 10;
  if (mod10 === 1 && mod100 !== 11) {
    return `${rank}ST`;
  }
  if (mod10 === 2 && mod100 !== 12) {
    return `${rank}ND`;
  }
  if (mod10 === 3 && mod100 !== 13) {
    return `${rank}RD`;
  }
  return `${rank}TH`;
};

/** Thousands-grouped points for the sector surfaces (1240 → "1,240"). */
export const fmtPts = (pts: number): string => pts.toLocaleString("en-US");

/** Counter-hints surfaced after 3 deaths to the same cause (≤8 words). */
export const DEATH_HINTS: ReadonlyMap<string, string> = new Map([
  ["LANCER", "it can't turn while charging"],
  ["DRONE", "its shots are slow — sidestep"],
  ["WASP", "break the orbit before the burst"],
  ["SPLITTER", "back away when it dies"],
  ["ASTEROID", "small rocks move fastest"],
  ["UFO", "shoot it — never touch it"],
  ["PLAYER", "keep moving, use your drift"],
]);

export const setText = (el: HTMLElement | null, text: string): void => {
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
};

/** Changed-only attributes keep progress semantics without live announcements. */
export const setAttribute = (el: HTMLElement | null, name: string, value: string): void => {
  if (el && el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
};
