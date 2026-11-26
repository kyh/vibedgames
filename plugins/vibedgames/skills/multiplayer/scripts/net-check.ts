#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { Browser, BrowserContext, BrowserType, Page } from "playwright";

type NetProbe = NonNullable<typeof globalThis.__VG_NET__>;

type NetStats = ReturnType<NetProbe["stats"]>;

type NetClientInfo = ReturnType<NetProbe["clients"]>[number];

interface Options {
  jitter: number;
  json: boolean;
  latency: number;
  loadTimeout: number;
  maxStalled: number;
  maxStarved: number;
  minFps: number;
  noDraw: boolean;
  roomParam: string;
  seconds: number;
  setState: string | null;
  url: string | null;
  viewport: { height: number; width: number };
  warmup: number;
}

type NumberOption =
  | "jitter"
  | "latency"
  | "loadTimeout"
  | "maxStalled"
  | "maxStarved"
  | "minFps"
  | "seconds"
  | "warmup";

type Verdict = "never connected" | "too slow" | "not measurable" | "stalls" | "choppy" | "smooth";

const printHelp = () => {
  const source = readFileSync(import.meta.filename, "utf-8");
  const match = /^(?:#![^\n]*\n)?\/\*\*(?<body>[\s\S]*?)\*\//u.exec(source);

  const text = (match?.groups?.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();

  process.stdout.write(`${text === "" ? "No help available." : text}\n`);
};

const NUMBER_FLAGS = new Map<string, NumberOption>([
  ["--jitter", "jitter"],
  ["--latency", "latency"],
  ["--load-timeout", "loadTimeout"],
  ["--max-stalled", "maxStalled"],
  ["--max-starved", "maxStarved"],
  ["--min-fps", "minFps"],
  ["--seconds", "seconds"],
  ["--warmup", "warmup"],
]);

type Parsed = { help: true } | { error: string } | { options: Options & { url: string } };

type ValueFlag = (options: Options, value: string | undefined) => string | null;

const setNumber: (name: NumberOption, flag: string) => ValueFlag =
  (name, flag) => (options, raw) => {
    const value = Number(raw);

    if (!Number.isFinite(value) || value < 0) {
      return `${flag} takes a non-negative number`;
    }

    options[name] = value;

    return null;
  };

const VALUE_FLAGS = new Map<string, ValueFlag>([
  [
    "--room-param",
    (options, value) => {
      options.roomParam = value ?? "";

      return null;
    },
  ],
  [
    "--set-state",
    (options, value) => {
      options.setState = value ?? null;

      return null;
    },
  ],
  [
    "--viewport",
    (options, value) => {
      const match = /^(?<width>\d+)x(?<height>\d+)$/u.exec(value ?? "");

      if (match?.groups === undefined) {
        return "--viewport takes WxH, e.g. 480x270";
      }

      options.viewport = { height: Number(match.groups.height), width: Number(match.groups.width) };

      return null;
    },
  ],
  ...[...NUMBER_FLAGS].map(([flag, name]) => {
    const entry: [string, ValueFlag] = [flag, setNumber(name, flag)];

    return entry;
  }),
]);

const parseArgs: (argv: string[]) => Parsed = (argv) => {
  const options: Options = {
    jitter: 40,
    json: false,
    latency: 80,
    loadTimeout: 30,
    maxStalled: 0.02,
    maxStarved: 0.1,
    minFps: 20,
    noDraw: false,
    roomParam: "room",
    seconds: 20,
    setState: null,
    url: null,
    viewport: { height: 270, width: 480 },
    warmup: 6,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const valueFlag = VALUE_FLAGS.get(arg);

    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }

    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-draw") {
      options.noDraw = true;
    } else if (valueFlag !== undefined) {
      const error = valueFlag(options, argv[(i += 1)]);

      if (error !== null) {
        return { error };
      }
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag ${arg}` };
    } else if (options.url === null) {
      options.url = arg;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }

  const { url } = options;

  if (url === null || url === "" || options.roomParam === "") {
    return { error: "usage: node net-check.ts <url> [flags] (see --help)" };
  }

  return { options: { ...options, url } };
};

type Frame = string | Buffer;

const delayed = (
  send: (data: Frame) => void,
  { latency, jitter }: { latency: number; jitter: number },
) => {
  const queue: { at: number; data: Frame }[] = [];
  let last = 0;
  let timer: NodeJS.Timeout | null = null;

  const pump = () => {
    timer = null;

    while (queue.length > 0 && (queue[0]?.at ?? Infinity) <= Date.now()) {
      const next = queue.shift();

      if (next !== undefined) {
        send(next.data);
      }
    }

    const [head] = queue;

    if (head !== undefined) {
      timer = setTimeout(pump, Math.max(0, head.at - Date.now()));
    }
  };

  return (data: Frame) => {
    const at = Math.max(last, Date.now() + latency + Math.random() * jitter);
    last = at;
    queue.push({ at, data });
    timer ??= setTimeout(pump, Math.max(0, at - Date.now()));
  };
};

const inOrder = async function* inOrder<T>(items: Iterable<T>) {
  yield* items;
};

const BROWSER_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

const launchBrowser: (
  chromium: BrowserType,
  channels?: readonly string[],
) => Promise<Browser> = async (chromium, channels = ["chrome", "chromium"]) => {
  const [channel, ...rest] = channels;

  if (channel === undefined) {
    return await chromium.launch({ args: BROWSER_ARGS });
  }

  try {
    return await chromium.launch({ args: BROWSER_ARGS, channel });
  } catch {
    return await launchBrowser(chromium, rest);
  }
};

const COUNT_FRAMES = `
globalThis.__NET_CHECK_FRAMES__ = 0;
const tick = () => {
  globalThis.__NET_CHECK_FRAMES__ += 1;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
`;

const NO_DRAW = `
for (const proto of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
  for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements", "clear", "blitFramebuffer"]) {
    if (proto && typeof proto[name] === "function") {
      proto[name] = () => {};
    }
  }
}
`;

const readNet = async (page: Page) =>
  await page.evaluate(() => {
    const probe = globalThis.__VG_NET__;

    return probe ? { clients: probe.clients(), stats: probe.stats() } : null;
  });

const waitForPlayer = async (page: Page, deadline: number) => {
  const net = await readNet(page);

  const joined =
    net?.clients.some(
      (c) => c.status === "connected" && c.playerId !== null && c.playerId !== "",
    ) ?? false;

  if (!joined && Date.now() < deadline) {
    await sleep(250);
    await waitForPlayer(page, deadline);
  }
};

const openClient = async (browser: Browser, url: string, options: Options) => {
  const context = await browser.newContext({ viewport: options.viewport });
  await context.addInitScript({ content: COUNT_FRAMES });

  if (options.noDraw) {
    await context.addInitScript({ content: NO_DRAW });
  }

  await context.routeWebSocket(/\/parties\//u, (ws) => {
    const server = ws.connectToServer();

    const up = delayed((data) => {
      server.send(data);
    }, options);

    const down = delayed((data) => {
      ws.send(data);
    }, options);

    ws.onMessage(up);
    server.onMessage(down);

    ws.onClose(async (code, reason) => {
      await server.close({ code, reason });
    });
    server.onClose(async (code, reason) => {
      await ws.close({ code, reason });
    });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { timeout: options.loadTimeout * 1000, waitUntil: "load" });

  if (options.setState !== null && options.setState !== "") {
    await page.evaluate(async (state) => {
      await globalThis.__GAME_TEST_HOOKS__?.setState?.(state);
    }, options.setState);
  }

  await waitForPlayer(page, Date.now() + options.loadTimeout * 1000);

  return { context, errors, page };
};

const movesOf = async (page: Page) =>
  await page.evaluate(() => {
    const moves = Object.values(globalThis.__GAME_PLAYTEST__?.move ?? {})
      .map((move) => move.keys ?? [])
      .filter((keys) => keys.length > 0);

    return moves.length > 0
      ? moves
      : [
          ["ArrowRight", "KeyD"],
          ["ArrowDown", "KeyS"],
          ["ArrowLeft", "KeyA"],
          ["ArrowUp", "KeyW"],
        ];
  });

const driveFrom = async (page: Page, moves: string[][], until: number, i: number) => {
  if (Date.now() >= until) {
    return;
  }

  const keys = moves[i % moves.length] ?? [];

  for await (const key of inOrder(keys)) {
    await page.keyboard.down(key);
  }

  await sleep(700);

  for await (const key of inOrder(keys)) {
    await page.keyboard.up(key);
  }

  await driveFrom(page, moves, until, i + 1);
};

const drive = async (page: Page, until: number) => {
  await driveFrom(page, await movesOf(page), until, 0);
};

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

interface ClientReport {
  connected: boolean;
  errors: string[];
  fps: number;
  role: "none" | "host" | "guest";
  rttMs: number | null;
  stalled: number;
  starved: number;
  stats: NetStats;
}

const judge: (client: ClientReport, options: Options) => Verdict = (client, options) => {
  const { stats } = client;

  if (!client.connected) {
    return "never connected";
  }

  if (client.fps < options.minFps) {
    return "too slow";
  }

  if (stats.frames === 0) {
    return "not measurable";
  }

  if (ratio(stats.stalled, stats.frames) > options.maxStalled) {
    return "stalls";
  }

  if (ratio(stats.starved, stats.frames) > options.maxStarved) {
    return "choppy";
  }

  return "smooth";
};

const roleOf = (self: NetClientInfo | null) => {
  if (self === null) {
    return "none";
  }

  return self.isHost ? "host" : "guest";
};

interface OpenClient {
  context: BrowserContext;
  errors: string[];
  page: Page;
}

const measure = async (pages: OpenClient[], options: Options) => {
  await sleep(options.warmup * 1000);

  const startFrames = await Promise.all(
    pages.map(
      async ({ page }) =>
        await page.evaluate(() => {
          globalThis.__VG_NET__?.reset();

          return globalThis.__NET_CHECK_FRAMES__;
        }),
    ),
  );

  const started = Date.now();
  await Promise.all(
    pages.map(async ({ page }) => {
      await drive(page, started + options.seconds * 1000);
    }),
  );
  const elapsed = (Date.now() - started) / 1000;

  return await Promise.all(
    pages.map(async ({ page, errors }, i) => {
      const frames = await page.evaluate(() => globalThis.__NET_CHECK_FRAMES__);
      const net = await readNet(page);
      const self = net?.clients.find((c) => c.status === "connected") ?? net?.clients[0] ?? null;
      const stats = net?.stats ?? { frames: 0, stalled: 0, starved: 0, updates: 0 };
      const rtt = self?.rttMs ?? null;

      const client: ClientReport = {
        connected: self?.status === "connected",
        errors,
        fps: Math.round(((frames ?? Number.NaN) - (startFrames[i] ?? Number.NaN)) / elapsed),
        role: roleOf(self),
        rttMs: rtt !== null && Number.isFinite(rtt) ? Math.round(rtt) : null,
        stalled: Number(ratio(stats.stalled, stats.frames).toFixed(4)),
        starved: Number(ratio(stats.starved, stats.frames).toFixed(4)),
        stats,
      };

      return { ...client, verdict: judge(client, options) };
    }),
  );
};

const exitCodeOf = (verdicts: Verdict[]) => {
  if (
    verdicts.some(
      (verdict) => verdict === "never connected" || verdict === "stalls" || verdict === "choppy",
    )
  ) {
    return 1;
  }

  if (verdicts.includes("too slow") || verdicts.every((verdict) => verdict === "not measurable")) {
    return 3;
  }

  return 0;
};

interface Report {
  clients: (ClientReport & { verdict: Verdict })[];
  exitCode: number;
  jitterMs: number;
  latencyMs: number;
  limits: { maxStalled: number; maxStarved: number; minFps: number };
  noDraw: boolean;
  ok: boolean;
  room: string;
  seconds: number;
  url: string;
}

const printReport = (report: Report, options: Options) => {
  console.log(
    `net-check ${report.url}\n  ${options.latency} ms ± ${options.jitter} ms one way, ${options.seconds} s measured`,
  );

  for (const client of report.clients) {
    console.log(
      `  ${client.role.padEnd(5)} ${client.verdict.padEnd(15)} ${client.fps} fps · rtt ${client.rttMs ?? "?"} ms · ` +
        `${client.stats.frames} frames · starved ${(client.starved * 100).toFixed(1)}% · ` +
        `stalled ${(client.stalled * 100).toFixed(1)}% · ${client.stats.updates} updates`,
    );

    for (const error of client.errors.slice(0, 3)) {
      console.log(`    page error: ${error}`);
    }
  }

  if (options.noDraw) {
    console.log("  WebGL drawing was off (--no-draw): the frame rates are the game's code alone.");
  }

  if (report.clients.some((client) => client.verdict === "too slow")) {
    const hint = options.noDraw ? "" : " With no GPU, try --no-draw.";
    console.log(
      `  A page ran below ${options.minFps} fps: this machine is the bottleneck, not the netcode.${hint}`,
    );
  } else if (report.exitCode === 3) {
    console.log("  Nothing was drawn through Interpolator, so this check can't judge the netcode.");
  }
};

const loadChromium = async () => {
  try {
    const { chromium } = await import("playwright");

    return chromium;
  } catch {
    return null;
  }
};

const run = async (options: Options & { url: string }) => {
  const chromium = await loadChromium();

  if (chromium === null) {
    console.error("Playwright not found. Install it in the game project: npm i -D playwright");

    return 2;
  }

  const room = `nc${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const target = new URL(options.url);
  target.searchParams.set(options.roomParam, room);

  const browser = await launchBrowser(chromium);

  try {
    const first = await openClient(browser, target.href, options);
    const second = await openClient(browser, target.href, options);
    const clients = await measure([first, second], options);
    const exitCode = exitCodeOf(clients.map((client) => client.verdict));

    const report: Report = {
      clients,
      exitCode,
      jitterMs: options.jitter,
      latencyMs: options.latency,
      limits: {
        maxStalled: options.maxStalled,
        maxStarved: options.maxStarved,
        minFps: options.minFps,
      },
      noDraw: options.noDraw,
      ok: exitCode === 0,
      room,
      seconds: options.seconds,
      url: target.href,
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printReport(report, options);
    }

    await Promise.all(
      [first, second].map(async ({ context }) => {
        await context.close();
      }),
    );

    return exitCode;
  } finally {
    await browser.close();
  }
};

const parsed = parseArgs(process.argv.slice(2));

if ("help" in parsed) {
  printHelp();
  process.exit(0);
}

if ("error" in parsed) {
  console.error(parsed.error);
  process.exit(2);
}

try {
  process.exit(await run(parsed.options));
} catch (error) {
  console.error(`net-check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
