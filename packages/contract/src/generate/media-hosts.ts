const HOSTS = new Set(["fal.media", "fal.run", "fal.ai"]);
const SUFFIXES = [".fal.media", ".fal.run", ".fal.ai"] as const;

const HTTPS = /^https:\/\/(?<host>[a-z0-9.-]+)(?::\d{1,5})?(?:[/?#]|$)/iu;

export const isMediaUrl = (url: string) => {
  const host = HTTPS.exec(url)?.groups?.host?.toLowerCase();

  if (!host) {
    return false;
  }

  return HOSTS.has(host) || SUFFIXES.some((suffix) => host.endsWith(suffix));
};
