import worker from "../.cloudflare/output/v0/workers/default/bundle/index.js";

export default {
  fetch(request, env, ctx) {
    const headers = new Headers(request.headers);
    headers.delete("host");

    return worker.fetch(new Request(request.url, { headers, method: request.method }), env, ctx);
  },
};
