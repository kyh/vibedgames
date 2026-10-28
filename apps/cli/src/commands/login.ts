import { exec } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { defineCommand } from "citty";
import { consola } from "consola";

import { getBaseUrl, saveConfig } from "../lib/config.js";
import { OAuthError, pollDeviceToken, requestDeviceCode } from "../lib/oauth.js";

/** RFC 8628 §3.5: each `slow_down` adds five seconds to the polling interval. */
const SLOW_DOWN_STEP_MS = 5000;

const openBrowser = (url: string): void => {
  const openers: Partial<Record<NodeJS.Platform, string>> = { darwin: "open", win32: "start" };
  const cmd = openers[process.platform] ?? "xdg-open";
  exec(`${cmd} "${url}"`);
};

const fail = (message: string): never => {
  consola.error(message);
  process.exit(1);
};

export const loginCommand = defineCommand({
  meta: {
    description: "Authenticate with vibedgames",
    name: "login",
  },
  run: async () => {
    const baseUrl = getBaseUrl();
    const device = await requestDeviceCode(baseUrl);

    consola.box(`Code: ${device.userCode}`);
    consola.info(
      `Opening ${device.verificationUriComplete}: approve there if it shows this same code.`,
    );
    openBrowser(device.verificationUriComplete);

    consola.start("Waiting for approval...");

    let intervalMs = device.interval * 1000;
    const deadline = Date.now() + device.expiresIn * 1000;
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      try {
        saveConfig(await pollDeviceToken(baseUrl, device.deviceCode));
        consola.success("Logged in successfully");
        return;
      } catch (error) {
        if (!(error instanceof OAuthError)) {
          throw error;
        }
        if (error.code === "slow_down") {
          intervalMs += SLOW_DOWN_STEP_MS;
        } else if (error.code === "access_denied") {
          fail("Login was denied in the browser.");
        } else if (error.code === "expired_token") {
          fail("Code expired. Run `vg login` to try again.");
        } else if (error.code !== "authorization_pending") {
          throw error;
        }
      }
    }

    fail("Timed out waiting for approval. Run `vg login` to try again.");
  },
});
