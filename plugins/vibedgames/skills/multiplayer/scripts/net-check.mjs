#!/usr/bin/env node
/**
 * net-check.mjs — measure how a multiplayer game's netcode holds up under
 * latency, with no human at the keyboard.
 *
 * Opens the game twice in headless Chromium, in one fresh room, with every
 * party-server WebSocket frame delayed both ways (latency plus random jitter,
 * never reordered: a real socket is ordered). Both clients move — the keys
 * come from the game's `window.__GAME_PLAYTEST__` moves, else arrows + WASD —
 * and each reports what it drew of the other through `window.__VG_NET__`,
 * which `@vibedgames/multiplayer` publishes on its own: every remote-entity
 * frame an `Interpolator` rendered, how many it drew past the newest update
 * (starved: the next one came too late, so it extrapolated or held), and how
 * many it held still past the extrapolation limit (stalled: a visible freeze).
 *
 * Usage:
 *   node net-check.mjs <url> [--latency <ms>] [--jitter <ms>] [--seconds <n>]
 *                            [--warmup <n>] [--room-param <name>] [--set-state <name>]
 *                            [--max-starved <0..1>] [--max-stalled <0..1>]
 *                            [--min-fps <n>] [--viewport <WxH>] [--no-draw]
 *                            [--load-timeout <s>] [--json]
 *
 * Examples:
 *   node net-check.mjs http://localhost:5173
 *   node net-check.mjs http://localhost:5173 --latency 150 --jitter 60 --json
 *
 * Defaults: --latency 80 --jitter 40 (one way, so round trips of 160–240 ms),
 * --seconds 20 measured after --warmup 6 (clocks settle), --room-param room,
 * --max-starved 0.1, --max-stalled 0.02, --min-fps 20, --viewport 480x270,
 * --load-timeout 30 (seconds each page may take to load and join the room).
 *
 * Frame rate: two pages share one machine, and a page that can't keep up sends
 * and draws late however good its netcode is. Each page's frame rate over the
 * measured window is reported, and below --min-fps the verdict is "too slow"
 * rather than a lag figure the machine made up. The small default viewport
 * keeps software-rendered WebGL (no GPU) near real time.
 *
 * No GPU (a container, CI): software WebGL holds a 3D scene to a few frames a
 * second, so the verdict would be "too slow" whatever the netcode. --no-draw
 * turns every WebGL draw call and clear in both pages into a no-op: the
 * game's own code, its sockets and its Interpolators run as on a real device,
 * so the verdict reads the netcode. The pages show nothing, so take
 * screenshots without it. A canvas-2D game doesn't need it. A scene whose
 * renderer spends the frame in its own JavaScript (thousands of meshes) stays
 * slow even so: there the renderer's render() itself has to be skipped, from a
 * dev-only hook the game exposes.
 *
 * The game must join the room named by `?<room-param>=` on load (a fresh id
 * per run, so concurrent checks never meet) and render remotes through
 * `Interpolator`. A game whose menu stands between load and the room can name
 * a `window.__GAME_TEST_HOOKS__.setState` state that joins it: `--set-state`.
 * (Not "active-play" by default: that state often means a solo run.) Point the
 * check at a dev server, not a deployed game: the clients join whatever party
 * host the build uses.
 *
 * Exit codes:
 *   0 = both clients connected and drew each other within the limits
 *   1 = too many starved or stalled frames, or a client never connected
 *   2 = error (navigation failure, missing Playwright, bad args)
 *   3 = not measurable: nothing was drawn through `Interpolator` (the game
 *       renders remotes another way — lockstep, step tracks — or none moved),
 *       or a page ran below --min-fps
 *
 * Requires Playwright 1.48+ (WebSocket routing), resolvable from the game
 * project: run from the game dir, or `npm i -D playwright` there.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** Print this file's header docblock, so `--help` cannot drift from the docs. */
const printHelp = () => {
  const source = readFileSync(import.meta.filename, "utf-8");
  const match = /^(?:#![^\n]*\n)?\/\*\*(?<body>[\s\S]*?)\*\//u.exec(source);
  const text = (match?.groups?.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();
  process.stdout.write(`${text || "No help available."}\n`);
};

const NUMBER_FLAGS = {
  "--jitter": "jitter",
  "--latency": "latency",
  "--load-timeout": "loadTimeout",
  "--max-stalled": "maxStalled",
  "--max-starved": "maxStarved",
  "--min-fps": "minFps",
  "--seconds": "seconds",
  "--warmup": "warmup",
};

const parseArgs = (argv) => {
  const options = {
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
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-draw") {
      options.noDraw = true;
    } else if (arg === "--room-param") {
      options.roomParam = argv[(i += 1)];
    } else if (arg === "--set-state") {
      options.setState = argv[(i += 1)] ?? null;
    } else if (arg === "--viewport") {
      const match = /^(?<width>\d+)x(?<height>\d+)$/u.exec(argv[(i += 1)] ?? "");
      if (!match?.groups) {
        return { error: "--viewport takes WxH, e.g. 480x270" };
      }
      options.viewport = { height: Number(match.groups.height), width: Number(match.groups.width) };
    } else if (arg in NUMBER_FLAGS) {
      const value = Number(argv[(i += 1)]);
      if (!Number.isFinite(value) || value < 0) {
        return { error: `${arg} takes a non-negative number` };
      }
      options[NUMBER_FLAGS[arg]] = value;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag ${arg}` };
    } else if (options.url === null) {
      options.url = arg;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }
  if (!options.url || !options.roomParam) {
    return { error: "usage: node net-check.mjs <url> [flags] (see --help)" };
  }
  return { options };
};

/**
 * One direction of a socket, delayed: each frame waits latency plus up to
 * `jitter`, and never overtakes the frame before it. One timer chain per
 * direction, because separate timers with equal deadlines may fire out of order.
 */
const delayed = (send, { latency, jitter }) => {
  const queue = [];
  let last = 0;
  let timer = null;
  const pump = () => {
    timer = null;
    while (queue.length > 0 && queue[0].at <= Date.now()) {
      send(queue.shift().data);
    }
    if (queue.length > 0) {
      timer = setTimeout(pump, Math.max(0, queue[0].at - Date.now()));
    }
  };
  return (data) => {
    const at = Math.max(last, Date.now() + latency + Math.random() * jitter);
    last = at;
    queue.push({ at, data });
    timer ??= setTimeout(pump, Math.max(0, at - Date.now()));
  };
};

/** The browser: a real Chrome/Chromium first (GPU), the bundled headless shell last. */
const launchBrowser = async (chromium) => {
  // Two headless pages starve each other's rAF unless timers stay unthrottled.
  const args = [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  for (const channel of ["chrome", "chromium"]) {
    try {
      return await chromium.launch({ args, channel });
    } catch {
      // try the next channel
    }
  }
  return chromium.launch({ args });
};

// Counts animation frames in the page, to tell a slow machine from slow netcode.
const COUNT_FRAMES = `
globalThis.__NET_CHECK_FRAMES__ = 0;
const tick = () => {
  globalThis.__NET_CHECK_FRAMES__ += 1;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
`;

// --no-draw: WebGL draws and clears do nothing, so a machine with no GPU
// spends no time rasterizing in software. Everything else in the page runs.
const NO_DRAW = `
for (const proto of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
  for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements", "clear", "blitFramebuffer"]) {
    if (proto && typeof proto[name] === "function") {
      proto[name] = () => {};
    }
  }
}
`;

const readNet = (page) =>
  page.evaluate(() => {
    const probe = globalThis.__VG_NET__;
    return probe ? { clients: probe.clients(), stats: probe.stats() } : null;
  });

/** Open the game in a fresh context with lagged party sockets, and wait for it to join the room. */
const openClient = async (browser, url, options) => {
  const context = await browser.newContext({ viewport: options.viewport });
  await context.addInitScript({ content: COUNT_FRAMES });
  if (options.noDraw) {
    await context.addInitScript({ content: NO_DRAW });
  }
  await context.routeWebSocket(/\/parties\//u, (ws) => {
    const server = ws.connectToServer();
    const up = delayed((data) => server.send(data), options);
    const down = delayed((data) => ws.send(data), options);
    ws.onMessage(up);
    server.onMessage(down);
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { timeout: options.loadTimeout * 1000, waitUntil: "load" });
  if (options.setState) {
    await page.evaluate(async (state) => {
      await globalThis.__GAME_TEST_HOOKS__?.setState?.(state);
    }, options.setState);
  }
  const deadline = Date.now() + options.loadTimeout * 1000;
  let net = await readNet(page);
  while (
    !net?.clients.some((c) => c.status === "connected" && c.playerId) &&
    Date.now() < deadline
  ) {
    await sleep(250);
    net = await readNet(page);
  }
  return { context, errors, page };
};

/** The keys each move holds: the game's playtest moves, else arrows + WASD in a square. */
const movesOf = (page) =>
  page.evaluate(() => {
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

/** Hold each move in turn until `until`, so every client keeps moving. */
const drive = async (page, until) => {
  const moves = await movesOf(page);
  for (let i = 0; Date.now() < until; i += 1) {
    const keys = moves[i % moves.length];
    for (const key of keys) {
      await page.keyboard.down(key);
    }
    await sleep(700);
    for (const key of keys) {
      await page.keyboard.up(key);
    }
  }
};

const ratio = (part, whole) => (whole > 0 ? part / whole : 0);

const judge = (client, options) => {
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

const roleOf = (self) => {
  if (!self) {
    return "none";
  }
  return self.isHost ? "host" : "guest";
};

/** Reset both pages' totals after the warm-up, drive both, and read what each drew. */
const measure = async (pages, options) => {
  await sleep(options.warmup * 1000);
  const startFrames = await Promise.all(
    pages.map(({ page }) =>
      page.evaluate(() => {
        globalThis.__VG_NET__?.reset();
        return globalThis.__NET_CHECK_FRAMES__;
      }),
    ),
  );
  const started = Date.now();
  await Promise.all(pages.map(({ page }) => drive(page, started + options.seconds * 1000)));
  const elapsed = (Date.now() - started) / 1000;
  const clients = [];
  for (const [i, { page, errors }] of pages.entries()) {
    const frames = await page.evaluate(() => globalThis.__NET_CHECK_FRAMES__);
    const net = await readNet(page);
    const self = net?.clients.find((c) => c.status === "connected") ?? net?.clients[0] ?? null;
    const stats = net?.stats ?? { frames: 0, stalled: 0, starved: 0, updates: 0 };
    const client = {
      connected: self?.status === "connected",
      errors,
      fps: Math.round((frames - startFrames[i]) / elapsed),
      role: roleOf(self),
      rttMs: Number.isFinite(self?.rttMs) ? Math.round(self.rttMs) : null,
      stalled: Number(ratio(stats.stalled, stats.frames).toFixed(4)),
      starved: Number(ratio(stats.starved, stats.frames).toFixed(4)),
      stats,
    };
    clients.push({ ...client, verdict: judge(client, options) });
  }
  return clients;
};

/** 1 for a failure, 3 when the run can't judge, 0 otherwise. */
const exitCodeOf = (verdicts) => {
  if (verdicts.some((verdict) => ["never connected", "stalls", "choppy"].includes(verdict))) {
    return 1;
  }
  if (verdicts.includes("too slow") || verdicts.every((verdict) => verdict === "not measurable")) {
    return 3;
  }
  return 0;
};

const printReport = (report, options) => {
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

const run = async (options) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright not found. Install it in the game project: npm i -D playwright");
    return 2;
  }
  // Short, lowercase and random from the first character: games that keep
  // only a room code's first few letters and digits still get a fresh room.
  const room = `nc${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const target = new URL(options.url);
  target.searchParams.set(options.roomParam, room);

  const browser = await launchBrowser(chromium);
  try {
    // The first in becomes host; the second joins its room as a guest.
    const first = await openClient(browser, target.href, options);
    const second = await openClient(browser, target.href, options);
    const clients = await measure([first, second], options);
    const exitCode = exitCodeOf(clients.map((client) => client.verdict));
    const report = {
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
    await Promise.all([first, second].map(({ context }) => context.close()));
    return exitCode;
  } finally {
    await browser.close();
  }
};

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  printHelp();
  process.exit(0);
}
if (parsed.error) {
  console.error(parsed.error);
  process.exit(2);
}
try {
  process.exit(await run(parsed.options));
} catch (error) {
  console.error(`net-check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
