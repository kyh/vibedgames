import { appRouter } from "@repo/api";
import { openAPIComponents } from "@repo/api/openapi";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod";

import { REST_PREFIX } from "@/lib/orpc-handler";
import { siteConfig } from "@/lib/site-config";

const generator = new OpenAPIGenerator({
  converters: [new ZodToJsonSchemaConverter()],
});

export const generateOpenAPISpec = () =>
  generator.generate(appRouter, {
    base: {
      components: openAPIComponents,
      externalDocs: { description: "Developer docs", url: `${siteConfig.url}/docs` },
      info: {
        contact: { email: siteConfig.contact.email ?? undefined, url: `${siteConfig.url}/contact` },
        description: [
          `The ${siteConfig.name} platform API: deploy browser games, generate assets, run playtests. The \`vg\` CLI is the reference client.`,
          `Every operation is a POST with a JSON body under ${REST_PREFIX}; errors are JSON with a stable \`code\` and a \`message\`.`,
          `The same procedures are also served at \`POST /api/orpc/<router>/<procedure>\` in oRPC's own wire format (body wrapped as \`{"json": …}\`), which the CLI and web app use.`,
          "Operations without a security requirement are public. The rest take a session cookie, a bearer token from `vg login`, or an API key (`vg_…`); a few refuse API keys and need a real session.",
        ].join("\n\n"),
        license: { name: "MIT", url: `${siteConfig.repository}/blob/main/LICENSE` },
        title: `${siteConfig.name} API`,
        version: "1.0.0",
      },
      openapi: "3.1.1",
      servers: [{ url: `${siteConfig.url}${REST_PREFIX}` }],
    },
  });
