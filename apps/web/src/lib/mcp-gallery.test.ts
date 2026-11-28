import assert from "node:assert/strict";
import { test } from "node:test";

import { featuredGames } from "@/components/game/data";
import { browseGames } from "@/lib/mcp-gallery";
import { browseOutput } from "@/lib/mcp-gallery-schema";

const slugs = (input: Parameters<typeof browseGames>[0]) =>
  browseGames(input).games.map((game) => game.slug);

test("browseGames lists every featured game, in the site's order", () => {
  assert.deepStrictEqual(
    slugs({}),
    featuredGames.map((game) => game.slug),
  );
});

test("browseGames keeps games matching every query word, in any field and any case", () => {
  assert.deepStrictEqual(slugs({ query: "Webcam" }), ["flappy-dragons", "pong"]);
  assert.deepStrictEqual(slugs({ query: "3d shooter" }), ["strikeforce"]);
  assert.deepStrictEqual(slugs({ query: "  " }), slugs({}));
  assert.deepStrictEqual(slugs({ query: "no such game" }), []);
});

test("browseGames filters by tag, alone or with a query", () => {
  assert.deepStrictEqual(slugs({ tag: "camera" }), ["flappy-dragons", "pacman", "pong"]);
  assert.deepStrictEqual(slugs({ query: "pong", tag: "camera" }), ["pong"]);
});

test("browseGames returns what its output schema promises, on absolute URLs", () => {
  const result = browseOutput.parse(browseGames({}));
  const pong = result.games.find((game) => game.slug === "pong");

  assert.strictEqual(pong?.coverUrl, "https://www.vibedgames.com/covers/pong.webp");
  assert.strictEqual(pong.playUrl, "https://pong.vibedgames.com");
  assert.strictEqual(result.galleryUrl, "https://www.vibedgames.com/discover");
});
