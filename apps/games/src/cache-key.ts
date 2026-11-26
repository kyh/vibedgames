/** The edge-cache key of an asset: one per deployment, path and encoding. */
export const assetCacheKey = (
  url: URL,
  deploymentId: string,
  requestedPath: string,
  compressed: boolean,
) => {
  const key = new URL(url.toString());
  key.pathname = `/__asset/${deploymentId}/${requestedPath}`;

  if (compressed) {
    key.searchParams.set("__enc", "gzip");
  }

  return new Request(key.toString(), { method: "GET" });
};
