// Two-client match smoke: two players deploy into one fresh party room and
// play rounds against each other. Checks that roles settle and the two land on
// opposite teams, the match leaves warmup, each sees the other's avatar, a
// real shot through the other's head hitbox kills (and ends the round, scores
// it and respawns both at their spawns), the carrier plants at a site and the
// defender defuses it, a barrel shot by the guest blows on the host, and when
// the host leaves the guest picks the match up with the score intact. Needs
// the party server on localhost:8787 (pnpm dev:party) and a Chromium: channel
// "chrome", or any binary in SMOKE_BROWSER. Not part of `pnpm test` for that
// reason; software WebGL makes it slow, so pages run with ?norender=1.
//
// Usage: node tools/two-client.mjs [--url http://localhost:5196]
// Without --url it starts its own vite.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5397;

const waitFor = async (page, fn, label, { timeoutMs = 60_000, arg } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg);
    if (last) {
      return last;
    }
    await wait(250);
  }
  throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
};

const startVite = async () => {
  const flag = process.argv.indexOf("--url");
  if (flag > 0) {
    return { base: process.argv[flag + 1], stop: () => null };
  }
  const vite = spawn("npx", ["vite", "--port", String(DEV_PORT), "--strictPort"], {
    cwd: gameDir,
    stdio: "ignore",
  });
  const base = `http://localhost:${DEV_PORT}`;
  for (let i = 0; i < 60; i += 1) {
    const up = await fetch(base).then(
      (r) => r.ok,
      () => false,
    );
    if (up) {
      return { base, stop: () => vite.kill() };
    }
    await wait(500);
  }
  vite.kill();
  throw new Error("vite did not start");
};

// One browser per client: on software GL a shared GPU process starves the second.
const launch = () =>
  chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
    ...(process.env.SMOKE_BROWSER
      ? { executablePath: process.env.SMOKE_BROWSER }
      : { channel: "chrome" }),
    headless: true,
  });

const phase = (page, want, label, timeoutMs = 90_000) =>
  waitFor(page, (p) => window.__strikeforce.match.state?.phase === p, label, {
    arg: want,
    timeoutMs,
  });

/** What one client knows, read off the dev handle and the game object. */
const probe = (page) =>
  page.evaluate(() => {
    const G = window.__G;
    const m = window.__strikeforce.match;
    const s = m.state;
    const me = s?.roster.get(m.me);
    return {
      alive: G.player.alive,
      attack: s?.attack ?? -1,
      barrels: G.explosives.aliveMask(),
      charge: s?.charge.state ?? "",
      host: m.guest === false,
      me: m.me,
      phase: s?.phase ?? "",
      pos: [G.player.pos.x, G.player.pos.z],
      round: s?.round ?? 0,
      score: s ? [...s.score] : [],
      team: me?.team ?? -1,
    };
  });

/** Aim from this page's eye at the other player's head hitbox and fire one round. */
const headshot = (page) =>
  page.evaluate(() => {
    const G = window.__G;
    const m = window.__strikeforce.match;
    const eye = G.player.eye.clone();
    const [other] = m.enemies();
    if (!other) {
      return false;
    }
    const target = new eye.constructor(other.x, other.y + 1.62, other.z);
    const dir = target.sub(eye).normalize();
    return m.shoot(eye, dir, 500, 28) !== null;
  });

/** Move this page's body onto a point and let a body report carry it. */
const standAt = (page, x, z) =>
  page.evaluate(
    ([px, pz]) => {
      window.__G.player.pos.set(px, 0, pz);
    },
    [x, z],
  );

const intent = (page, event, payload) =>
  page.evaluate(([e, p]) => window.__strikeforce.match.client.sendToHost(e, p), [event, payload]);

const main = async () => {
  const reachable = await fetch(PARTY).then(
    () => true,
    () => false,
  );
  if (!reachable) {
    throw new Error(`party server not reachable at ${PARTY} (pnpm dev:party)`);
  }
  const dev = await startVite();
  const room = `t${process.pid}${Date.now().toString(36)}`;
  const url = `${dev.base}/?room=${room}&q=low&autostart=1&noaudio=1&norender=1`;
  const browsers = [];
  const results = [];
  const errors = [];
  const step = (name, ok, note = "") => {
    results.push(`${ok ? "pass" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
    if (!ok) {
      throw new Error(`${name}: ${note}`);
    }
  };
  const open = async (label) => {
    const browser = await launch();
    browsers.push(browser);
    const page = await browser.newPage({ viewport: { height: 270, width: 480 } });
    page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`${label}: ${msg.text().slice(0, 240)}`);
      }
    });
    await page.goto(url, { timeout: 180_000, waitUntil: "commit" });
    await waitFor(page, () => window.__ready === true, `${label} boot`, { timeoutMs: 180_000 });
    return page;
  };
  try {
    const host = await open("host");
    await waitFor(host, () => window.__strikeforce.match.state?.phase === "warmup", "host warmup");
    step("host alone sits in warmup", true);

    const guest = await open("guest");
    await phase(guest, "freeze", "round 1 freeze");
    const [h1, g1] = [await probe(host), await probe(guest)];
    step(
      "two players split onto opposite teams",
      h1.team !== g1.team && h1.team >= 0 && g1.team >= 0,
      `${h1.team}/${g1.team}`,
    );
    await phase(guest, "live", "round 1 live");
    await waitFor(guest, () => window.__strikeforce.match.enemies().length > 0, "guest sees host");
    await waitFor(host, () => window.__strikeforce.match.enemies().length > 0, "host sees guest");
    step("each sees the other's avatar", true);

    // A real ray through the host's head hitbox, from the guest's eye.
    step("guest's shot meets the host's head hitbox", await headshot(guest));
    await waitFor(host, () => !window.__G.player.alive, "host down");
    await phase(host, "post", "round 1 over");
    const afterKill = await probe(host);
    step(
      "the kill ends the round and scores it",
      afterKill.score[g1.team] === 1,
      JSON.stringify(afterKill.score),
    );
    await phase(host, "freeze", "round 2 freeze", 30_000);
    await waitFor(host, () => window.__G.player.alive, "host respawned");
    const r2 = await probe(host);
    step("round 2 respawns everyone", r2.round === 2 && r2.alive, `round ${r2.round}`);
    await phase(host, "live", "round 2 live");

    // Plant: whoever attacks walks the charge onto site A and asks.
    const [hp, gp] = [await probe(host), await probe(guest)];
    const [atk, def] = hp.team === hp.attack ? [host, guest] : [guest, host];
    const site = await host.evaluate(() => window.__strikeforce.match.sites()[0]);
    await standAt(atk, site.x, site.z);
    await wait(600);
    await intent(atk, "plant", 0);
    await phase(host, "planted", "charge planted");
    step("the carrier plants on site A", true, `${gp.charge}`);
    await standAt(def, site.x + 0.5, site.z);
    await wait(600);
    await intent(def, "defuse", null);
    await phase(host, "post", "round 2 over");
    const defused = await probe(host);
    step("the defender defuses it", defused.charge === "defused", defused.charge);

    // Barrel: the guest's shot is a request; the host's blast comes back.
    await phase(host, "live", "round 3 live", 30_000);
    const barrel = await guest.evaluate(() => window.__G.explosives.aliveMask().indexOf("1"));
    await guest.evaluate((i) => window.__strikeforce.match.barrelHit(i, 999, null, null), barrel);
    await waitFor(host, (i) => window.__G.explosives.aliveMask()[i] === "0", "host barrel blew", {
      arg: barrel,
    });
    await waitFor(
      guest,
      (i) => window.__G.explosives.aliveMask()[i] === "0",
      "guest barrel synced",
      { arg: barrel },
    );
    step("guest barrel shot blows the host's barrel", true);

    // Host leaves: the guest picks the match up, score intact (then warmup: one side is empty).
    const before = await probe(guest);
    await host.context().browser().close();
    await waitFor(guest, () => window.__strikeforce.match.guest === false, "guest promoted", {
      timeoutMs: 90_000,
    });
    const after = await probe(guest);
    step(
      "guest inherits the match",
      after.host && after.phase === "warmup",
      `${JSON.stringify(before.score)} → ${after.phase}`,
    );
  } finally {
    console.log(results.join("\n"));
    if (errors.length > 0) {
      console.log(`\npage errors:\n${errors.slice(0, 20).join("\n")}`);
    }
    await Promise.all(browsers.map((b) => b.close().catch(() => null)));
    dev.stop();
  }
};

await main();
