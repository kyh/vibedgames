import assert from "node:assert/strict";
import { test } from "node:test";

import { isLobbyName, listRooms, quickMatch } from "../src/lobby.js";

test("a lobby name is letters, digits, - and _, up to 64", () => {
  for (const name of ["bomberman", "pong-ranked", "a_b-9", "x".repeat(64)]) {
    assert.equal(isLobbyName(name), true, name);
  }
  for (const name of ["", "has space", "a/b", "room~2", "é", "x".repeat(65)]) {
    assert.equal(isLobbyName(name), false, name);
  }
});

test("asking a lobby that cannot be named fails before any request", async () => {
  // Nothing listens here, so a request would fail differently.
  const host = "http://127.0.0.1:9";
  await assert.rejects(listRooms({ host, lobby: "a/b" }), /not a lobby name/u);
  await assert.rejects(quickMatch({ host, lobby: "" }), /not a lobby name/u);
});
