import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { styleText } from "node:util";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractClient } from "@repo/contract";
import { z } from "zod";

const BASE_URL = (process.env.SMOKE_URL ?? "http://localhost:5173").replace(/\/$/u, "");

const EMAIL = "user@vibedgames.com";

const SEEDED_TOKEN = "dev-local-session-token-0000000000";

const FOREIGN_ORIGIN = "https://elsewhere.example";

const deadline = () => AbortSignal.timeout(30_000);

const BOOT_BUDGET_MS = 180_000;

class SmokeError extends Error {
  override name = "SmokeError";
}

const fail: (message: string) => never = (message) => {
  throw new SmokeError(message);
};

const url = (route: string) => `${BASE_URL}${route}`;

const BROWSER_HEADERS = { origin: BASE_URL };

let cookie = "";

const clientWith = (headers: () => Record<string, string>) =>
  createORPCClient<ContractClient>(
    new RPCLink({
      fetch: async (request, init) => await fetch(request, { ...init, signal: deadline() }),
      headers,
      origin: BASE_URL,
      url: "/api/orpc",
    }),
  );

const browser = clientWith(() => (cookie ? { ...BROWSER_HEADERS, cookie } : BROWSER_HEADERS));

const cli = clientWith(() => ({ authorization: `Bearer ${SEEDED_TOKEN}` }));

const describeResponse = async (response: Response) => {
  const body = await response.text().catch(() => "<unreadable body>");
  const trimmed = body.replaceAll(/\s+/gu, " ").trim();

  return `HTTP ${response.status} — ${trimmed.slice(0, 400) || "<empty body>"}`;
};

const probeLogin = async () => {
  try {
    const response = await fetch(url("/auth/login"), { redirect: "manual", signal: deadline() });

    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const pollLogin: (startedAt: number, attempts: number, lastSeen: string) => Promise<void> = async (
  startedAt,
  attempts,
  lastSeen,
) => {
  if (performance.now() - startedAt >= BOOT_BUDGET_MS) {
    fail(
      `server never answered /auth/login at ${BASE_URL} within ${BOOT_BUDGET_MS / 1000}s ` +
        `(${attempts} attempts) — last saw: ${lastSeen}`,
    );
  }

  const seen = await probeLogin();

  if (seen === null) {
    return;
  }

  await sleep(500);
  await pollLogin(startedAt, attempts + 1, seen);
};

const mintSignInCode = () =>
  execFileSync("pnpm", ["--silent", "sign-in-code", EMAIL], { encoding: "utf-8" }).trim();

const signInWithCode = async (origin: string) =>
  await fetch(url("/api/auth/sign-in/email-otp"), {
    body: JSON.stringify({ email: EMAIL, otp: mintSignInCode() }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
    signal: deadline(),
  });

const signIn = async () => {
  const response = await signInWithCode(BASE_URL);

  if (!response.ok) {
    fail(
      `sign-in as ${EMAIL} failed: ${await describeResponse(response)}. ` +
        "Is the local D1 seeded? (pnpm bootstrap --yes)",
    );
  }

  const cookies = response.headers.getSetCookie();

  if (cookies.length === 0) {
    fail("sign-in succeeded but set no session cookie");
  }

  cookie = cookies.map((value) => value.split(";")[0]).join("; ");
};

const toolsList = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
});

const sseData = (stream: string) =>
  stream
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");

const step = async <T>(label: string, run: () => Promise<T>) => {
  const startedAt = performance.now();
  let result: T;

  try {
    result = await run();
  } catch (error) {
    if (error instanceof SmokeError) {
      throw error;
    }

    return fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const elapsed = styleText("dim", `${Math.round(performance.now() - startedAt)}ms`);
  console.log(`  ${styleText("green", "✓")} ${label} ${elapsed}`);

  return result;
};

const main = async () => {
  console.log(`\n  Smoke test → ${BASE_URL}\n`);

  await step("the web app answers /auth/login", async () => {
    await pollLogin(performance.now(), 0, "no response at all");
  });

  await step("a code's sign-in from another site is refused", async () => {
    const response = await signInWithCode(FOREIGN_ORIGIN);

    if (response.status !== 403) {
      fail(`a sign-in from ${FOREIGN_ORIGIN} answered ${await describeResponse(response)}`);
    }
  });

  await step(`signed in as ${EMAIL} by an emailed code`, signIn);

  await step("auth.me answers the signed-in user", async () => {
    const me = await browser.auth.me();

    if (me.email !== EMAIL) {
      fail(`auth.me answered ${me.email ?? "no email"}, not ${EMAIL}`);
    }
  });

  await step("credits.me reads the ledger", async () => {
    const credits = await browser.credits.me();

    if (!Number.isInteger(credits.balanceMicro)) {
      fail(`credits.me answered a balance of ${String(credits.balanceMicro)}`);
    }
  });

  await step("the seeded token lists deployments, as vg does", async () => {
    await cli.deploy.list();
  });

  await step("/mcp lists the deploy tool with no credential", async () => {
    const response = await fetch(url("/mcp"), {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
      signal: deadline(),
    });

    if (!response.ok) {
      fail(`/mcp tools/list answered ${await describeResponse(response)}`);
    }

    const body = await response.text();
    const message = body.startsWith("{") ? body : sseData(body);
    const { result } = toolsList.parse(JSON.parse(message));

    if (!result.tools.some((tool) => tool.name === "deploy")) {
      fail(`/mcp listed ${result.tools.length} tools, none named deploy`);
    }
  });

  await step("signed out, auth.me refuses", async () => {
    const response = await fetch(url("/api/auth/sign-out"), {
      body: "{}",
      headers: { ...BROWSER_HEADERS, "content-type": "application/json", cookie },
      method: "POST",
      signal: deadline(),
    });

    if (!response.ok) {
      fail(`sign-out failed: ${await describeResponse(response)}`);
    }

    const after = await fetch(url("/api/orpc/auth/me"), {
      body: JSON.stringify({ json: {} }),
      headers: { ...BROWSER_HEADERS, "content-type": "application/json", cookie },
      method: "POST",
      signal: deadline(),
    });

    if (after.status !== 401) {
      fail(`auth.me after sign-out answered ${await describeResponse(after)}, not 401`);
    }
  });

  console.log(`\n  ${styleText("green", "Smoke test passed.")}\n`);
};

const run = async () => {
  try {
    await main();
  } catch (error) {
    console.error(
      `\n  ${styleText("red", "✗ Smoke test failed:")} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
};

void run();
