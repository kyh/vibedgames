/**
 * The origin a deployed game is served at: its slug as a subdomain of the
 * platform's registrable domain. The web app lives on `www.`, games beside it,
 * so `https://www.vibedgames.com` and `https://vibedgames.com` both put
 * `my-game` at `https://my-game.vibedgames.com`.
 */
export const gameOrigin = (baseUrl: string | URL, slug: string) => {
  const base = new URL(baseUrl);
  const host = base.host.startsWith("www.") ? base.host.slice("www.".length) : base.host;

  return `${base.protocol}//${slug}.${host}`;
};
