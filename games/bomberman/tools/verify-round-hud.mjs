import assert from "node:assert/strict";
import { test } from "node:test";
import { FUSE_MS, COLORS } from "../src/shared/constants.ts";
import { bombStock, RoundHud } from "../src/render/round-hud.ts";

function bomb(id, ownerId, placedAt) {
  return { id, ownerId, placedAt, col: 1, row: 1, range: 2 };
}

test("bomb stock uses accepted ownership and earliest live fuse, independent of record order", () => {
  const bombs = [bomb("new", "me", 2000), bomb("other", "other", 0), bomb("old", "me", 1000)];
  const before = structuredClone(bombs);
  const stock = bombStock(bombs, "me", 3, 2100);
  assert.equal(stock.available, 1);
  assert.equal(stock.capacity, 3);
  assert.equal(stock.next.remaining, 1100);
  assert.equal(stock.next.progress, 0.5);
  assert.deepEqual(bombStock(bombs.toReversed(), "me", 3, 2100), stock);
  assert.deepEqual(bombs, before);
  assert.deepEqual(bombStock(bombs, null, 1, 2100), { available: 1, capacity: 1, next: null });
});

test("elapsed fuse cannot optimistically release capacity before authoritative removal", () => {
  const held = [bomb("a", "me", 1000)];
  assert.deepEqual(bombStock(held, "me", 1, 1000 + FUSE_MS), {
    available: 0,
    capacity: 1,
    next: { remaining: 0, progress: 1 },
  });
  assert.equal(bombStock(held, "me", 1, 9000).available, 0);
  assert.deepEqual(
    bombStock([], "me", 1, 1500),
    { available: 1, capacity: 1, next: null },
    "early chain removal frees the accepted slot immediately",
  );
  assert.deepEqual(
    bombStock(held, "me", 1, 900),
    {
      available: 0,
      capacity: 1,
      next: { remaining: 2300, progress: 0 },
    },
    "clock correction cannot produce negative progress",
  );
});

function element() {
  const classes = new Set();
  return {
    hidden: true,
    textContent: "",
    className: "",
    dataset: {},
    style: {},
    attrs: {},
    children: [],
    writes: 0,
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
      this.writes++;
    },
    classList: {
      toggle(key, on) {
        if (on) classes.add(key);
        else classes.delete(key);
      },
      contains(key) {
        return classes.has(key);
      },
    },
  };
}

function fixture() {
  const nodes = new Map(
    [
      "stat-bomb",
      "bomb-availability",
      "bomb-refill",
      "bomb-refill-fill",
      "players",
      "placement-tip",
    ].map((id) => [id, element()]),
  );
  globalThis.document = { getElementById: (id) => nodes.get(id), createElement: () => element() };
  return { hud: new RoundHud(), nodes };
}

test("actual DOM owner renders availability/refill labels, waits honestly, and clears after detonation", () => {
  const { hud, nodes } = fixture();
  const held = [bomb("a", "me", 1000)];
  hud.updateBombs(held, "me", 1, 2100);
  assert.equal(nodes.get("stat-bomb").textContent, "0/1");
  assert.equal(
    nodes.get("bomb-availability").attrs["aria-label"],
    "0 of 1 bombs available. Next fuse ends in 1.1 seconds.",
  );
  assert.equal(nodes.get("bomb-refill-fill").style.width, "50%");
  assert.equal(nodes.get("bomb-refill").hidden, false);
  hud.updateBombs(held, "me", 1, 5000);
  assert.match(nodes.get("bomb-availability").attrs["aria-label"], /Waiting for detonation/);
  assert.equal(nodes.get("stat-bomb").textContent, "0/1");
  hud.updateBombs([], "me", 1, 5000);
  assert.equal(nodes.get("stat-bomb").textContent, "1/1");
  assert.equal(nodes.get("bomb-refill").hidden, true);
  assert.equal(nodes.get("bomb-availability").classList.contains("empty"), false);
});

test("actual roster retains identity color, counts surviving fighters, and renders names only as text", () => {
  const { hud, nodes } = fixture();
  const fighters = [
    { id: "me", label: "you", colorIdx: 0, alive: true, isLocal: true, isBot: false },
    { id: "bot-1", label: "CPU 1", colorIdx: 2, alive: false, isLocal: false, isBot: true },
    {
      id: "remote",
      label: "<img onerror=attack>",
      colorIdx: 1,
      alive: true,
      isLocal: false,
      isBot: false,
    },
  ];
  const before = structuredClone(fighters);
  hud.updateRoster(fighters);
  const roster = nodes.get("players");
  assert.equal(roster.children[0].textContent, "2 alive");
  const chips = roster.children[1].children;
  assert.equal(chips[0].children[0].style.backgroundColor, `#${COLORS[0].toString(16)}`);
  assert.match(chips[1].className, /out/);
  assert.equal(chips[2].children[1].textContent, fighters[2].label);
  hud.updateRoster(structuredClone(fighters));
  assert.equal(roster.writes, 1, "unchanged snapshot never recreates roster nodes");
  assert.deepEqual(fighters, before);
  fighters[2].alive = false;
  hud.updateRoster(fighters);
  assert.equal(roster.children[0].textContent, "1 alive");
});

test("accepted placement cue is once per round, uses only caller clock, and cannot backlog after disposal", () => {
  const { hud, nodes } = fixture();
  const tip = nodes.get("placement-tip");
  hud.update(50000);
  assert.equal(tip.hidden, true, "no speculation before accepted contact");
  hud.acceptedPlacement(50000);
  assert.equal(tip.hidden, false);
  hud.update(53599);
  assert.equal(tip.hidden, false);
  hud.acceptedPlacement(53599);
  hud.update(53600);
  assert.equal(tip.hidden, true, "later bombs do not prolong the first cue");
  hud.acceptedPlacement(54000);
  assert.equal(tip.hidden, true);
  hud.reset();
  hud.acceptedPlacement(1000);
  assert.equal(tip.hidden, false);
  hud.dispose();
  hud.dispose();
  assert.equal(tip.hidden, true);
  hud.acceptedPlacement(1100);
  hud.updateBombs([], "me", 8, 1100);
  hud.updateRoster([]);
  assert.equal(tip.hidden, true);
  assert.equal(nodes.get("stat-bomb").textContent, "");
  assert.equal(nodes.get("players").writes, 0);
});

test("pause preserves the caller's fuse progress; inactive presentation clears tip without rearming it", () => {
  const { hud, nodes } = fixture();
  const held = [bomb("a", "me", 1000), bomb("peer", "other", 500)];
  hud.acceptedPlacement(2000);
  hud.updateBombs(held, "me", 1, 2100);
  const label = nodes.get("bomb-availability").attrs["aria-label"];
  const progress = nodes.get("bomb-refill-fill").style.width;
  for (let frame = 0; frame < 60; frame++) {
    hud.updateBombs(held, "me", 1, 2100);
    hud.update(2100, false);
  }
  assert.equal(nodes.get("bomb-availability").attrs["aria-label"], label);
  assert.equal(nodes.get("bomb-refill-fill").style.width, progress);
  assert.equal(nodes.get("placement-tip").hidden, true);
  hud.update(2100, true);
  hud.acceptedPlacement(2200);
  assert.equal(
    nodes.get("placement-tip").hidden,
    true,
    "resume cannot replay a consumed teaching cue",
  );
  hud.reset();
  hud.acceptedPlacement(2300);
  assert.equal(nodes.get("placement-tip").hidden, false);
  hud.update(2301, false);
  assert.equal(
    nodes.get("placement-tip").hidden,
    true,
    "death/result/start gate hides immediately too",
  );
  hud.updateBombs(held, "me", 1, 2200);
  assert.notEqual(
    nodes.get("bomb-refill-fill").style.width,
    progress,
    "only the resumed shared clock advances progress",
  );
});
