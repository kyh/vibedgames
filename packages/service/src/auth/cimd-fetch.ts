/**
 * The network boundary `@better-auth/cimd` requires for fetching a client's
 * metadata document (the `client_id` URL an MCP client presents) on Workers.
 *
 * The plugin asks for resolve-once DNS, a refusal of special-use addresses,
 * a connection pinned to the approved address, and no redirects. Its Node
 * transport does that with `dns.lookup` and a pinned socket, neither of which
 * a Worker has. A Worker's `fetch` leaves through Cloudflare's edge, which is
 * what refuses the private side: it answers a direct IP literal with error
 * 1003 and a hostname resolving to a loopback, private or otherwise
 * prohibited address with error 1000, and the edge resolves and connects in
 * one step, so there is no window between the check and the connection. What
 * remains for this function is what the edge does not decide: HTTPS only,
 * reads only, no IP literals, no redirects, and a bounded wait.
 */
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";

const FETCH_TIMEOUT_MS = 5000;
const READ_METHODS = new Set(["GET", "HEAD"]);
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/iu;

export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    throw new TypeError("client metadata must be fetched over HTTPS");
  }
  if (!READ_METHODS.has(request.method)) {
    throw new TypeError("client metadata is only ever read");
  }
  if (IP_LITERAL.test(url.hostname) || !isPublicRoutableHost(url.hostname)) {
    throw new TypeError("client metadata must be served from a public hostname");
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  // `manual`: a redirect comes back as the 3xx it is, which the plugin
  // refuses, rather than being followed somewhere this function never saw.
  const response = await fetch(url, {
    headers: request.headers,
    method: request.method,
    redirect: "manual",
    signal,
  });
  if (response.status >= 300 && response.status < 400) {
    throw new TypeError("client metadata must not redirect");
  }
  return response;
};
