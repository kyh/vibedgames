// Near-black HUD palette with a violet accent — same family as the kyh.io
// terminal dashboards, tinted for vibedgames.
export const color = {
  bg: "#0A0A0F",
  // grayscale ramp
  text: "#E6E6E6",
  dim: "#8A8A8A",
  faint: "#4A4A4A",
  ghost: "#2A2A2A",
  // borders
  border: "#2E2E38",
  borderActive: "#54487E",
  // accent
  accent: "#A78BFA",
  accentDim: "#6D5BAA",
  // feed tones
  ok: "#4ADE80",
  warn: "#FBBF24",
  err: "#F87171",
  tool: "#67E8F9",
  black: "#000000",
} as const;

// Thin technical border set used for every panel — single-line, squared corners.
export const panelBorder = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  topT: "┬",
  bottomT: "┴",
  leftT: "├",
  rightT: "┤",
  cross: "┼",
} as const;
