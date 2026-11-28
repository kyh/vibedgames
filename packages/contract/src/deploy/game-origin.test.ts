import assert from "node:assert/strict";
import { test } from "node:test";

import { gameOrigin } from "./game-origin";

test("gameOrigin puts the slug beside the www web host, not under it", () => {
  assert.equal(gameOrigin("https://www.vibedgames.com", "pong"), "https://pong.vibedgames.com");
  assert.equal(gameOrigin("https://www.vibedgames.com/", "pong"), "https://pong.vibedgames.com");
});

test("gameOrigin keeps an apex base URL working", () => {
  assert.equal(gameOrigin("https://vibedgames.com", "pong"), "https://pong.vibedgames.com");
});

test("gameOrigin keeps the base's protocol and port", () => {
  assert.equal(
    gameOrigin(new URL("http://www.example.test:8787"), "a"),
    "http://a.example.test:8787",
  );
});

test("gameOrigin strips only a leading www label", () => {
  assert.equal(gameOrigin("https://wwwx.example.com", "a"), "https://a.wwwx.example.com");
  assert.equal(
    gameOrigin("https://staging.www.example.com", "a"),
    "https://a.staging.www.example.com",
  );
});
