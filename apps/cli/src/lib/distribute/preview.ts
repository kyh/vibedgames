import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { unzipSync } from "fflate";

import { contentTypeForPath } from "@repo/contract/deploy/content-types";

import type { Portal } from "./portals.js";
import { YTGAME_STUB } from "./ytgame-stub.js";

/**
 * A zip served the way a portal serves it: unpacked under a folder, framed by
 * a page on another origin, under the portal's Content-Security-Policy. The
 * game is on 127.0.0.1 and the page framing it on localhost, which the browser
 * treats as two origins.
 */

export interface PreviewOptions {
  zip: Uint8Array;
  portal: Portal;
  /** The game's port; the framing page takes the next one. */
  port: number;
}

export interface Preview {
  /** The page to open: the game framed as the portal frames it. */
  url: string;
  /** The game alone, at its folder on the game origin. */
  gameUrl: string;
  close: () => Promise<void>;
}

const GAME_PATH = "/play/";
const STUB_PATH = "/__vg/sdk.js";

const PAGE_CSS =
  "body{margin:0;display:grid;grid-template-rows:auto 1fr;height:100vh;font:13px ui-monospace,monospace;background:#111;color:#ddd}" +
  "header{display:flex;gap:8px;align-items:center;padding:8px;flex-wrap:wrap}button{font:inherit;padding:4px 10px}" +
  "iframe{border:0;width:100%;height:100%;background:#000}pre{margin:0;max-height:30vh;overflow:auto;white-space:pre-wrap}";

const previewPage = (portal: Portal, gameUrl: string) => {
  const controls =
    portal.integration === null
      ? ""
      : `<button data-a="pause">YouTube pause</button><button data-a="resume">YouTube resume</button>` +
        `<button data-a="audio-off">Audio off</button><button data-a="audio-on">Audio on</button><pre id="log"></pre>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${portal.name} preview</title><style>${PAGE_CSS}</style></head><body>
<header><strong>${portal.name} preview</strong>${controls}</header>
<iframe id="game" src="${gameUrl}" allow="autoplay; fullscreen; gamepad"></iframe>
<script>
const frame = document.getElementById("game");
const send = (action, enabled) => frame.contentWindow.postMessage({ type: "vg-ytgame", action, enabled }, "*");
window.vgPreview = {
  log: { calls: [], errors: [], save: null },
  pause: () => send("pause"),
  resume: () => send("resume"),
  setAudio: (enabled) => send("audio", enabled),
};
addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || !event.data || event.data.type !== "vg-ytgame-log") return;
  window.vgPreview.log = event.data.log;
  const out = document.getElementById("log");
  if (out) out.textContent = [...event.data.log.errors.map((e) => "ERROR " + e), ...event.data.log.calls.slice(-8)].join("\\n");
});
for (const button of document.querySelectorAll("button[data-a]")) {
  button.addEventListener("click", () => {
    const a = button.dataset.a;
    if (a === "audio-on" || a === "audio-off") send("audio", a === "audio-on");
    else send(a);
  });
}
</script></body></html>`;
};

const listen: (server: Server, port: number, host: string) => Promise<void> = async (
  server,
  port,
  host,
) => {
  server.listen(port, host);
  await once(server, "listening");
};

const closeServer: (server: Server) => Promise<void> = async (server) => {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
};

const send = (
  res: ServerResponse,
  status: number,
  type: string,
  body: Uint8Array | string,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { "cache-control": "no-store", "content-type": type, ...headers });
  res.end(body);
};

export const startPreview = async ({ zip, portal, port }: PreviewOptions) => {
  const files = unzipSync(zip);

  if (!("index.html" in files)) {
    throw new Error("The zip has no index.html at its root.");
  }

  const { integration } = portal;
  const decoder = new TextDecoder();

  const serveGame = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (integration !== null && url.pathname === STUB_PATH) {
      send(res, 200, "text/javascript; charset=utf-8", YTGAME_STUB);

      return;
    }

    if (!url.pathname.startsWith(GAME_PATH)) {
      send(res, 404, "text/plain", "Not in the game's folder.");

      return;
    }

    const relative = decodeURIComponent(url.pathname.slice(GAME_PATH.length)) || "index.html";
    const body = files[relative];

    if (body === undefined) {
      send(res, 404, "text/plain", `${relative} is not in the zip.`);

      return;
    }

    if (relative !== "index.html") {
      send(res, 200, contentTypeForPath(relative), body);

      return;
    }

    if (integration === null) {
      send(res, 200, "text/html; charset=utf-8", body);

      return;
    }

    const html = decoder.decode(body).replaceAll(integration.script, STUB_PATH);
    send(res, 200, "text/html; charset=utf-8", html, {
      "content-security-policy": integration.csp,
    });
  };

  const gameUrl = `http://127.0.0.1:${port}${GAME_PATH}index.html`;
  const page = previewPage(portal, gameUrl);
  const game = createServer(serveGame);

  const host = createServer((_req, res) => {
    send(res, 200, "text/html; charset=utf-8", page);
  });

  try {
    await listen(game, port, "127.0.0.1");
    await listen(host, port + 1, "localhost");
  } catch (error) {
    await closeServer(game);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not listen on ports ${port}-${port + 1} (${reason}). Pass --port.`, {
      cause: error,
    });
  }

  return {
    close: async () => {
      await Promise.all([closeServer(game), closeServer(host)]);
    },
    gameUrl,
    url: `http://localhost:${port + 1}/`,
  };
};
