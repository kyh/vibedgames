import { spawn } from "node:child_process";

/**
 * Best-effort operator notification for events that block on a human: a build
 * awaiting deploy approval, a checkpoint window, a rate-limit stall. The loop
 * runs unattended for hours — journal entries alone don't reach anyone.
 *
 * Channel resolution: if FACTORY_NOTIFY is set it's run via `sh -c` with
 * FACTORY_NOTIFY_TITLE / FACTORY_NOTIFY_MESSAGE in the environment (point it
 * at ntfy, a Slack webhook curl, terminal-notifier, …). Otherwise on macOS a
 * native notification is posted via osascript. Elsewhere it's a no-op. Always
 * fire-and-forget: a broken notifier must never stall or crash the loop.
 */
export function notifyOperator(title: string, message: string): void {
  const custom = process.env.FACTORY_NOTIFY;
  try {
    if (custom) {
      spawn("sh", ["-c", custom], {
        env: { ...process.env, FACTORY_NOTIFY_TITLE: title, FACTORY_NOTIFY_MESSAGE: message },
        stdio: "ignore",
        detached: true,
      }).unref();
      return;
    }
    if (process.platform === "darwin") {
      spawn(
        "osascript",
        ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
        { stdio: "ignore", detached: true },
      ).unref();
    }
  } catch {
    /* notification is best-effort by contract */
  }
}

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
