// Miniflare overwrites the `host` header with the loopback address, but the
// worker routes entirely on the `{slug}.vibedgames.com` subdomain. Dropping the
// header makes it fall back to the request URL's host, which dispatchFetch does
// honour — without this every request under test is "Invalid host".
import worker from "../dist/index.js";

export default {
  fetch(request, env, ctx) {
    const headers = new Headers(request.headers);
    headers.delete("host");
    return worker.fetch(new Request(request.url, { method: request.method, headers }), env, ctx);
  },
};
