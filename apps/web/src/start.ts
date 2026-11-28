import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

import { canonicalLocation } from "@/lib/canonical-host";

const canonicalHost = createMiddleware().server(async ({ next, request }) => {
  const location = canonicalLocation(new URL(request.url));

  return location === null ? await next() : Response.redirect(location, 308);
});

const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

export const startInstance = createStart(() => ({ requestMiddleware: [canonicalHost, csrf] }));
