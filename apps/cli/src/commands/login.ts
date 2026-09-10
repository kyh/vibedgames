import { exec } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { defineCommand } from "citty";
import { consola } from "consola";

import { createPublicClient } from "../lib/api.js";
import { getBaseUrl, saveConfig } from "../lib/config.js";

const POLL_INTERVAL_MS = 2000;
// 5 min at 2s intervals
const MAX_POLLS = 150;

const openBrowser = (url: string): void => {
  const openers: Partial<Record<NodeJS.Platform, string>> = { darwin: "open", win32: "start" };
  const cmd = openers[process.platform] ?? "xdg-open";
  exec(`${cmd} "${url}"`);
};

export const loginCommand = defineCommand({
  meta: {
    description: "Authenticate with vibedgames",
    name: "login",
  },
  run: async () => {
    const baseUrl = getBaseUrl();
    const client = createPublicClient(baseUrl);

    const { code } = await client.auth.cliInit();

    consola.box(`Code: ${code}`);
    consola.info("Opening browser to complete authentication...");

    const authUrl = `${baseUrl}/auth/cli?code=${code}`;
    openBrowser(authUrl);

    consola.start("Waiting for confirmation...");

    for (let i = 0; i < MAX_POLLS; i += 1) {
      await sleep(POLL_INTERVAL_MS);

      const result = await client.auth.cliPoll({ code });

      if (result.status === "confirmed") {
        saveConfig({ baseUrl, token: result.token });
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
