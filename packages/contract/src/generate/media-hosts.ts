/**
 * Whether `url` is an https file the media provider serves: its CDN, its run
 * hosts or its storage. The CLI downloads a result only from these, and
 * `deploy.upload` fetches a file only from these, so neither is a way to make
 * the server or the agent's machine fetch anything else.
 */
const HOSTS = new Set(["fal.media", "fal.run", "fal.ai"]);
const SUFFIXES = [".fal.media", ".fal.run", ".fal.ai"] as const;

// The authority of an https URL. The contract compiles without DOM or Node
// types, so there is no `URL` here; a login (`@`) or anything unusual in the
// host refuses the URL rather than risk reading it differently from `fetch`.
const HTTPS = /^https:\/\/(?<host>[a-z0-9.-]+)(?::\d{1,5})?(?:[/?#]|$)/iu;

export const isMediaUrl = (url: string): boolean => {
  const host = HTTPS.exec(url)?.groups?.host?.toLowerCase();
  if (!host) {
    return false;
  }
  return HOSTS.has(host) || SUFFIXES.some((suffix) => host.endsWith(suffix));
};
