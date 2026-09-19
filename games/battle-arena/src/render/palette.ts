// Deterministic per-team identity colors. FFA → each player/team a distinct hue.
const BLUE = 0x4f_86_ff;
const PALETTE = [
  BLUE,
  // green
  0x49_d6_7a,
  // violet
  0xc0_60_ff,
  // rose
  0xff_5a_78,
  // amber
  0xff_b1_3b,
  // teal
  0x40_d8_d8,
  // orange
  0xff_7a_3c,
  // chartreuse
  0xe0_e0_60,
];

export const LOCAL_COLOR = 0x46_e0_ff;

/** Stable color for a team string. The local player overrides to LOCAL_COLOR. */
export const teamColor = (team: string): number => {
  let h = 0;
  for (let i = 0; i < team.length; i += 1) {
    // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc -- int32 wrap keeps the hash mix in range
    h = (h * 31 + (team.codePointAt(i) ?? 0)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length] ?? BLUE;
};
