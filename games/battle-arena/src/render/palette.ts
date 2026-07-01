// Deterministic per-team identity colors. FFA → each player/team a distinct hue.
const PALETTE = [
  0x4f86ff, // blue
  0x49d67a, // green
  0xc060ff, // violet
  0xff5a78, // rose
  0xffb13b, // amber
  0x40d8d8, // teal
  0xff7a3c, // orange
  0xe0e060, // chartreuse
];

export const LOCAL_COLOR = 0x46e0ff;

/** Stable color for a team string. The local player overrides to LOCAL_COLOR. */
export function teamColor(team: string): number {
  let h = 0;
  for (let i = 0; i < team.length; i++) h = (h * 31 + team.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}
