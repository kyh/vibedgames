// `?offline=1` — the platform-wide boot switch that keeps a game entirely
// local: no party server, no WebSocket, no socket of any kind.
//
// It is a product guarantee before it is a QA flag. A game that looks
// single-player must not open a production socket over cellular with no way to
// opt out; and it is the switch that lets a coding agent verify a game in
// isolation, which is what this platform sells.
//
// "Offline" is NOT "the connection failed". Games also fall back to solo when
// the party server is unreachable (the client's `fallbackMs`), but that path
// still dials, still burns its grace window before the game is playable, and
// still logs a failed WebSocket handshake that the page cannot suppress.
// Offline means the client never dials and the game is solo from the first
// frame. Honour it with the client's `offline: isOfflineRequested()`, which
// opens no socket, never by leaning on the fallback.

/** True when this page was booted with `?offline` / `?offline=1`. */
export const isOfflineRequested = (): boolean => {
  // Guard for the games' headless sim harnesses, which import gameplay modules
  // under Node where there is no `location`.
  if (!("location" in globalThis)) {
    return false;
  }
  const value = new URLSearchParams(location.search).get("offline");
  // Presence alone is intent — a bare `?offline` from someone who mistyped the
  // documented form must never silently dial production. Only an explicit `0`
  // opts back in.
  return value !== null && value !== "0";
};
