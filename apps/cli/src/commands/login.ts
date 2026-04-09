import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { defineCommand } from "citty";
import consola from "consola";

import { getBaseUrl, saveConfig } from "../lib/config.js";

const LOGIN_TIMEOUT_MS = 120_000;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`);
}

function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Failed to find open port"));
      }
    });
  });
}

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Authenticate with vibedgames",
  },
  run: async () => {
    const baseUrl = getBaseUrl();
    const state = randomBytes(16).toString("hex");
    const port = await findOpenPort();

    consola.start("Waiting for authentication...");

    const result = await new Promise<{ token: string } | null>(
      (resolve) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", `http://localhost:${port}`);

          if (url.pathname === "/callback") {
            const token = url.searchParams.get("token");
            const returnedState = url.searchParams.get("state");

            if (returnedState !== state) {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<h1>Authentication failed</h1><p>Invalid state parameter. Please try again.</p>");
              resolve(null);
              return;
            }

            if (!token) {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<h1>Authentication failed</h1><p>No token received. Please try again.</p>");
              resolve(null);
              return;
            }

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>Authenticated!</h1><p>You can close this window and return to the CLI.</p>");
            resolve({ token });
            return;
          }

          res.writeHead(404);
          res.end();
        });

        server.listen(port, () => {
          const authUrl = `${baseUrl}/auth/cli?port=${port}&state=${state}`;
          consola.info(`Opening browser to: ${authUrl}`);
          openBrowser(authUrl);
        });

        const timeout = setTimeout(() => {
          server.close();
          resolve(null);
        }, LOGIN_TIMEOUT_MS);

        server.on("close", () => clearTimeout(timeout));
      },
    );

    if (!result) {
      consola.error("Authentication timed out or failed");
      process.exit(1);
    }

    saveConfig({ token: result.token, baseUrl });
    consola.success("Logged in successfully");
  },
});
