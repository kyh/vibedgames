export function parseRoomCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(code) ? code : null;
}

/** Invites carry only the room and ruleset, never a host's preview/debug flags. */
export function partyLink(href: string, code: string, mode: "coop" | "vs"): string {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("party", code);
  if (mode === "vs") url.searchParams.set("mode", "vs");
  return url.toString();
}
