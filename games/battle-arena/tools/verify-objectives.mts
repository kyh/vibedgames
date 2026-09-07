import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, spawnHero, step } from "../src/sim/world.ts";
import { encodeWorld } from "../src/net/snapshot.ts";
import { coinObjective, deliveryObjective } from "../src/render/objective-state.ts";
import { Hints } from "../src/render/hints.ts";
import type { Coin } from "../src/sim/types.ts";

function fixture() {
  const world = createWorld(724);
  const me = spawnHero(world, {
    id: "local",
    ownerId: "local",
    team: "local",
    champId: "knight",
    name: "Player",
    slot: 0,
    isBot: false,
  });
  return { world, me };
}
function coin(id: string, x = 0): Coin {
  return { id, x, y: 0, fromX: 0, fromY: 0, gold: 300, landAt: 900, expireAt: 9900 };
}

test("loot never becomes the boss objective; landing and expiry use authoritative clocks", () => {
  const { world, me } = fixture();
  world.coins.push({ ...coin("loot"), loot: true });
  assert.equal(coinObjective(world, me).target, null);
  assert.equal(coinObjective(world, me).text, "◈ COIN 8s");
  world.coins.push(coin("boss", 5));
  assert.equal(coinObjective(world, me).text, "◈ COIN LANDING 1s");
  assert.equal(coinObjective(world, me).live, false);
  world.now = 900;
  assert.equal(coinObjective(world, me).text, "◈ COIN 9s LEFT");
  assert.equal(coinObjective(world, me).live, true);
  world.now = 9900;
  assert.equal(coinObjective(world, me).target, null);
});

test("nearest objective remains stable until removed; snapshot ordering cannot flip it", () => {
  const { world, me } = fixture();
  me.x = me.y = 0;
  const close = coin("a", 2),
    far = coin("b", 8);
  world.coins = [far, close];
  assert.equal(coinObjective(world, me).target?.id, "a");
  assert.equal(coinObjective(world, me, "b").target?.id, "b");
  world.coins.reverse();
  assert.equal(coinObjective(world, me, "b").target?.id, "b");
  world.coins = [close];
  assert.equal(coinObjective(world, me, "b").target?.id, "a");
});

test("full belt explains delivery gold; expired and claimed drops lose their target", () => {
  const { world, me } = fixture();
  world.deliveries.push({ id: "drop", x: 0, y: 0, expireAt: 30000 });
  assert.equal(deliveryObjective(world, me).text, "▣ ITEM 30s LEFT");
  me.items = ["one", "two", "three", "four", "five", "six"];
  assert.equal(deliveryObjective(world, me).text, "▣ GOLD 30s LEFT");
  world.now = 30000;
  assert.equal(deliveryObjective(world, me).target, null);
  world.deliveries = [];
  assert.equal(deliveryObjective(world, me).target, null);
});

test("empty opening and creep loot do not retire the first boss-coin lesson", () => {
  const { world, me } = fixture();
  me.x = me.y = 100;
  me.gold = 0;
  me.lastAttackAt = me.lastCastAt = 1;
  const messages: string[] = [];
  const hints = new Hints(
    () => false,
    (message) => messages.push(message),
  );
  hints.update(world, me);
  me.x += 6;
  world.gameTime = 1;
  world.now = 1000;
  world.coins = [{ ...coin("loot"), loot: true }];
  hints.update(world, me);
  assert.equal(
    messages.some((message) => message.includes("Golem")),
    false,
  );
  world.gameTime = 8.1;
  world.now = 8100;
  world.coins = [{ ...coin("boss"), landAt: 8900, expireAt: 17900 }];
  hints.update(world, me);
  assert.equal(messages.filter((message) => message.includes("Golem")).length, 1);
  world.coins = [];
  hints.update(world, me);
  assert.equal(messages.at(-1), "");
  world.gameTime = 20;
  world.now = 20000;
  world.coins = [{ ...coin("boss2"), landAt: 20900, expireAt: 29900 }];
  hints.update(world, me);
  assert.equal(messages.filter((message) => message.includes("Golem")).length, 1);
  hints.resetMatch();
  world.gameTime = 8.1;
  world.now = 8100;
  hints.update(world, me);
  assert.equal(messages.filter((message) => message.includes("Golem")).length, 1);
});

test("observing actual economy ticks cannot alter coin schedules or payouts", () => {
  const observed = fixture(),
    control = fixture();
  const hints = new Hints(
    () => false,
    () => {},
  );
  let lastCoin: string | null = null;
  for (let i = 0; i < 1200; i++) {
    step(observed.world);
    step(control.world);
    lastCoin = coinObjective(observed.world, observed.me, lastCoin).target?.id ?? null;
    deliveryObjective(observed.world, observed.me);
    hints.update(observed.world, observed.me);
    assert.deepEqual(encodeWorld(observed.world), encodeWorld(control.world));
  }
});
