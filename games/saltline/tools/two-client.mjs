// Two-client co-op smoke: a host and a guest deploy into one fresh party room.
// Checks that roles settle, the guest draws the host's machines as puppets and
// sees the host's avatar (and the host the guest's), a guest hit kills a host
// machine and comes back as a kill credit, the host's machines can hurt the
// guest through its stand-in, a guest relay cut and barrel shot land on the
// host and come back to the guest, the host respawns into a live run instead of
// resetting it, and when the host leaves the guest takes the run over with the
// machines still standing. Needs the party server on localhost:8787 (pnpm
// dev:party) and a Chromium: channel "chrome", or any binary in SMOKE_BROWSER.
// Not part of `pnpm test` for that reason; software WebGL makes it slow.
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

/** What one client knows, read off the dev handle and the game object. */
const probe = (page) =>
  page.evaluate(() => {
    const G = window.__G;
    return {
      ...window.__saltline.coop.probe(),
      alive: G.enemies.list.filter((e) => e.alive).length,
      barrels: G.explosives.aliveMask(),
      cut: G.game.run.relays.filter((r) => r.cut).map((r) => r.id),
      health: G.player.health,
      kills: G.combat.stats.kills,
      run: G.game.run.runId,
      state: G.game.state,
    };
  });

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
    page.on("console", (m) => {
      if (m.type() === "error") {
        errors.push(`${label}: ${m.text().slice(0, 240)}`);
      }
    });
    await page.goto(url, { timeout: 180_000, waitUntil: "commit" });
    await waitFor(page, () => window.__ready === true, `${label} boot`, { timeoutMs: 180_000 });
    return page;
  };
  try {
    const host = await open("host");
    await waitFor(host, () => window.__saltline?.coop.probe().role === "host", "host role");
    await waitFor(host, () => window.__G.game.state === "playing", "host deployed");
    await waitFor(host, () => window.__G.enemies.list.some((e) => e.alive), "host patrols");
    step("host deploys and spawns patrols", true);

    const guest = await open("guest");
    await waitFor(guest, () => window.__saltline?.coop.probe().role === "guest", "guest role");
    await waitFor(guest, () => window.__saltline.coop.probe().puppets > 0, "guest puppets");
    const [h0, g0] = [await probe(host), await probe(guest)];
    step(
      "guest draws the host's machines",
      g0.puppets === h0.alive,
      `host ${h0.alive}, guest ${g0.puppets}`,
    );
    await waitFor(guest, () => window.__G.game.state === "playing", "guest deployed");
    await waitFor(
      host,
      () => window.__G.scene.children.some((c) => c.name.startsWith("squad:") && c.visible),
      "host sees guest",
    );
    await waitFor(
      guest,
      () => window.__G.scene.children.some((c) => c.name.startsWith("squad:") && c.visible),
      "guest sees host",
    );
    step("each sees the other's avatar", true);

    // A guest hit is a request: the host's machine dies and the kill comes back.
    const { kills: killsBefore } = await probe(guest);
    await guest.evaluate(() => {
      const body = window.__G.enemies.list.find((e) => e.alive);
      body.damage(9999, body.pos.clone(), null, "body");
    });
    await waitFor(
      host,
      (n) => window.__G.enemies.list.filter((e) => e.alive).length < n,
      "host machine down",
      { arg: h0.alive },
    );
    await waitFor(guest, (k) => window.__G.combat.stats.kills > k, "guest kill credit", {
      arg: killsBefore,
    });
    step("guest kill lands on the host and is credited", true);

    // The host's machines see the guest's stand-in; its hits arrive as hurt.
    const { health: hpBefore } = await probe(guest);
    await host.evaluate(() => {
      const { coop } = window.__saltline;
      const stand = coop.targets().find((t) => t !== window.__G.player);
      stand.damage(12, stand.pos.clone());
    });
    await waitFor(guest, (hp) => window.__G.player.health < hp, "guest hurt", { arg: hpBefore });
    step("host machines can hurt the guest", true);

    // Relay: the guest finishes a cut, the host applies it, the guest syncs.
    const relayId = await guest.evaluate(() => window.__G.game.run.relays[0]?.id ?? null);
    step("mission has relays", Boolean(relayId));
    await guest.evaluate((id) => window.__saltline.coop.requestCut(id), relayId);
    await waitFor(
      host,
      (id) => window.__G.game.run.relays.some((r) => r.id === id && r.cut),
      "host relay cut",
      { arg: relayId },
    );
    await waitFor(
      guest,
      (id) => window.__G.game.run.relays.some((r) => r.id === id && r.cut),
      "guest relay synced",
      { arg: relayId },
    );
    step("guest relay cut lands on the host and syncs back", true);

    // Barrel: the guest's shot is a request; the host's blast comes back.
    const barrel = await guest.evaluate(() => window.__G.explosives.aliveMask().indexOf("1"));
    await guest.evaluate((i) => window.__saltline.coop.barrelHit(i, 999, null, null), barrel);
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

    // Host dies and retries while the guest is out: the run carries on.
    const { run: runBefore } = await probe(host);
    await host.evaluate(() => window.__G.player.damage(999));
    await waitFor(host, () => window.__G.game.state === "dead", "host dead");
    await host.evaluate(() => window.__G.game.start({ quick: true }));
    await waitFor(
      host,
      () => window.__G.game.state === "intro" || window.__G.game.state === "playing",
      "host back",
    );
    const after = await probe(host);
    step(
      "host respawns into the live run",
      after.run === runBefore && after.cut.includes(relayId),
      `run ${runBefore}→${after.run}`,
    );

    // Host leaves: the guest takes the run over, machines and cuts intact.
    const { puppets: standing } = await probe(guest);
    await host.context().browser().close();
    await waitFor(guest, () => window.__saltline.coop.probe().role === "host", "guest promoted", {
      timeoutMs: 90_000,
    });
    const promoted = await probe(guest);
    const hunting = await guest.evaluate(
      () => window.__G.enemies.list.filter((e) => e.alive && !e.passive).length,
    );
    step(
      "guest inherits the run",
      hunting > 0 && promoted.cut.includes(relayId),
      `${hunting}/${standing} machines hunting`,
    );
  } finally {
    console.log(results.join("\n"));
    if (errors.length) {
      console.log(`\npage errors:\n${errors.slice(0, 20).join("\n")}`);
    }
    await Promise.all(browsers.map((b) => b.close()));
    dev.stop();
  }
};

await main();
