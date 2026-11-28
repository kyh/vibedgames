import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";

const FETCH_TIMEOUT_MS = 5000;
const READ_METHODS = new Set(["GET", "HEAD"]);
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/iu;

const requestUrl = (input: RequestInfo | URL) =>
  new URL(input instanceof Request ? input.url : input);

// WARNING: never `new Request(input, init)` here: init carries redirect "error", which workerd rejects.
export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input, init) => {
  const url = requestUrl(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.protocol !== "https:") {
    throw new TypeError("client metadata must be fetched over HTTPS");
  }

  if (!READ_METHODS.has(method)) {
    throw new TypeError("client metadata is only ever read");
  }

  if (IP_LITERAL.test(url.hostname) || !isPublicRoutableHost(url.hostname)) {
    throw new TypeError("client metadata must be served from a public hostname");
  }

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  const response = await fetch(url, {
    headers: init?.headers,
    method,
    redirect: "manual",
    signal,
  });

  if (response.status >= 300 && response.status < 400) {
    throw new TypeError("client metadata must not redirect");
  }

  return response;
};
