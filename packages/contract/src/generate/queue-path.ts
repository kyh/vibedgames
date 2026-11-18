export const endpointPath = (endpointId: string) => endpointId.replaceAll(/^\/+|\/+$/gu, "");

const QUEUE_APP_NAMESPACES = new Set(["workflows", "comfy"]);

export const queueAppId = (endpointId: string) => {
  const parts = endpointPath(endpointId).split("/").filter(Boolean);
  const take = QUEUE_APP_NAMESPACES.has(parts[0] ?? "") ? 3 : 2;

  return parts.slice(0, take).join("/");
};
