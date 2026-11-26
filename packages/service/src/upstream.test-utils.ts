import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { JsonValue } from "@repo/contract/json";

export interface UpstreamRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface UpstreamReply {
  drop?: boolean;
  status?: number;
  json?: JsonValue;
  text?: string;
}

export const startUpstream = async (reply: (request: UpstreamRequest) => UpstreamReply) => {
  const requests: UpstreamRequest[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request: UpstreamRequest = {
        body: Buffer.concat(chunks).toString("utf-8"),
        headers: req.headers,
        method: req.method ?? "GET",
        url: new URL(req.url ?? "/", "http://upstream.invalid"),
      };

      requests.push(request);
      const answer = reply(request);

      if (answer.drop === true) {
        req.socket.destroy();

        return;
      }

      const isJson = answer.json !== undefined;
      res.writeHead(answer.status ?? 200, {
        "content-type": isJson ? "application/json" : "text/plain",
      });
      res.end(isJson ? JSON.stringify(answer.json) : (answer.text ?? ""));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address instanceof Object ? address.port : 0;

  const close = async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  };

  return { close, origin: `http://127.0.0.1:${port}`, requests };
};
