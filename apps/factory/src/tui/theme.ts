// Near-black HUD palette with a violet accent — same family as the kyh.io
// terminal dashboards, tinted for vibedgames.
export const color = {
  accent: "#A78BFA",
  accentDim: "#6D5BAA",
  bg: "#0A0A0F",
  black: "#000000",
  border: "#2E2E38",
  borderActive: "#54487E",
  dim: "#8A8A8A",
  err: "#F87171",
  faint: "#4A4A4A",
  ghost: "#2A2A2A",
  ok: "#4ADE80",
  text: "#E6E6E6",
  tool: "#67E8F9",
  warn: "#FBBF24",
} as const;

// Thin technical border set used for every panel — single-line, squared corners.
export const panelBorder = {
  bottomLeft: "└",
  bottomRight: "┘",
  bottomT: "┴",
  cross: "┼",
  horizontal: "─",
  leftT: "├",
  rightT: "┤",
  topLeft: "┌",
  topRight: "┐",
  topT: "┬",
  vertical: "│",
} as const;
