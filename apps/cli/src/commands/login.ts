import { exec } from "node:child_process";
import { defineCommand } from "citty";
import consola from "consola";

import { createPublicClient } from "../lib/api.js";
import { getBaseUrl, saveConfig } from "../lib/config.js";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 150; // 5 min at 2s intervals

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Authenticate with vibedgames",
  },
  run: async () => {
    const baseUrl = getBaseUrl();
    const client = createPublicClient(baseUrl);

    const { code } = await client.auth.cliInit.mutate();

    consola.box(`Code: ${code}`);
    consola.info("Opening browser to complete authentication...");

    const authUrl = `${baseUrl}/auth/cli?code=${code}`;
    openBrowser(authUrl);

    consola.start("Waiting for confirmation...");

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS);

      const result = await client.auth.cliPoll.query({ code });

      if (result.status === "confirmed") {
        saveConfig({ token: result.token, baseUrl });
        consola.success("Logged in successfully");
        return;
      }

      if (result.status === "expired") {
        consola.error("Code expired. Run `vg login` to try again.");
        process.exit(1);
      }
    }

    consola.error("Timed out waiting for confirmation.");
    process.exit(1);
  },
});
