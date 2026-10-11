// The setup screen's wordmark, pre-rendered from the cfonts "tiny" (VG) and
// "slick" (FACTORY) fonts so drawing it needs no font engine at runtime.
export const VG_WORDMARK = ["█ █ █▀▀", "▀▄▀ █▄█"] as const;

export const FACTORY_WORDMARK = [
  "╭━━━╮ ╭━━━╮ ╭━━━╮ ╭━━━━╮ ╭━━━╮ ╭━━━╮ ╭╮╱╱╭╮",
  "┃╭━━╯ ┃╭━╮┃ ┃╭━╮┃ ┃╭╮╭╮┃ ┃╭━╮┃ ┃╭━╮┃ ┃╰╮╭╯┃",
  "┃╰━━╮ ┃┃╱┃┃ ┃┃╱╰╯ ╰╯┃┃╰╯ ┃┃╱┃┃ ┃╰━╯┃ ╰╮╰╯╭╯",
  "┃╭━━╯ ┃╰━╯┃ ┃┃╱╭╮ ╱╱┃┃╱╱ ┃┃╱┃┃ ┃╭╮╭╯ ╱╰╮╭╯╱",
  "┃┃╱╱╱ ┃╭━╮┃ ┃╰━╯┃ ╱╱┃┃╱╱ ┃╰━╯┃ ┃┃┃╰╮ ╱╱┃┃╱╱",
  "╰╯╱╱╱ ╰╯╱╰╯ ╰━━━╯ ╱╱╰╯╱╱ ╰━━━╯ ╰╯╰━╯ ╱╱╰╯╱╱",
] as const;
