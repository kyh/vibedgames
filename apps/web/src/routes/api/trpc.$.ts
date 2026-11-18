import { createFileRoute } from "@tanstack/react-router";

const UPGRADE_MESSAGE = "Your vibedgames CLI is out of date — run `npm i -g vibedgames@latest`.";

const TRPC_BAD_REQUEST = -32_600;

const upgradeRequiredResponse = (req: Request) => {
  const errorObj = {
    error: {
      json: {
        code: TRPC_BAD_REQUEST,
        data: {
          code: "BAD_REQUEST",
          httpStatus: 400,
        },
        message: UPGRADE_MESSAGE,
      },
    },
  };

  const url = new URL(req.url);
  const isBatch = url.searchParams.has("batch");
  let body: typeof errorObj | (typeof errorObj)[] = errorObj;

  if (isBatch) {
    const lastSegment = url.pathname.split("/").findLast((segment) => segment.length > 0) ?? "";
    const count = Math.max(1, lastSegment.split(",").filter((s) => s.length > 0).length);
    body = Array.from({ length: count }, () => errorObj);
  }

  return Response.json(body, {
    headers: { "content-type": "application/json" },
    status: 400,
  });
};

const handler = (req: Request) => {
  console.log(`>>> legacy tRPC hit: ${new URL(req.url).pathname}`);

  return upgradeRequiredResponse(req);
};

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
