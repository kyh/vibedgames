import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { FeaturedGame } from "@/components/game/data";
import type { SkillIndexEntry } from "@/lib/agent-skills";
import { featuredGames } from "@/components/game/data";

import { rankByQuery, searchGames, searchSkills, serverInstructions } from "./mcp-catalog";

const skill = (name: string, description: string): SkillIndexEntry => ({
  description,
  digest: "sha256:0",
  name,
  type: "skill-md",
  url: `https://vibedgames.com/.well-known/agent-skills/${name}/SKILL.md`,
});

const skills = [
  skill("deploy", "Ship a built game to its own subdomain."),
  skill("pixel-art", "Generate pixel art sprites and tilesets."),
  skill("animated-spritesheets", "Walk cycles and other pixel animations as spritesheets."),
];

describe("rankByQuery", () => {
  const items = [
    { description: "nothing", name: "alpha" },
    { description: "mentions beta", name: "gamma" },
    { description: "unrelated", name: "beta" },
  ];
  const fields = (item: (typeof items)[number]) => ({
    description: item.description,
    names: [item.name],
  });

  test("an empty or blank query returns every item in input order", () => {
    assert.deepEqual(rankByQuery(items, undefined, fields), items);
    assert.deepEqual(rankByQuery(items, "   ", fields), items);
  });

  test("a name hit outranks a description hit and misses are dropped", () => {
    assert.deepEqual(
      rankByQuery(items, "BETA", fields).map((item) => item.name),
      ["beta", "gamma"],
    );
  });

  test("tokens are OR'd, so one unknown word does not empty the result", () => {
    assert.deepEqual(
      rankByQuery(items, "alpha zzz", fields).map((item) => item.name),
      ["alpha"],
    );
  });
});

describe("searchSkills", () => {
  test("lists every skill as slug, description and SKILL.md url", () => {
    const all = searchSkills(skills);
    assert.equal(all.length, skills.length);
    assert.deepEqual(all[0], {
      description: "Ship a built game to its own subdomain.",
      slug: "deploy",
      url: "https://vibedgames.com/.well-known/agent-skills/deploy/SKILL.md",
    });
  });

  test("ranks a slug match above description-only matches", () => {
    assert.deepEqual(
      searchSkills(skills, "pixel").map((entry) => entry.slug),
      ["pixel-art", "animated-spritesheets"],
    );
  });
});

describe("searchGames", () => {
  test("returns only public fields and a subdomain play URL", () => {
    const [first] = searchGames(featuredGames, { limit: 1 });
    assert.ok(first);
    assert.deepEqual(Object.keys(first).toSorted(), ["description", "playUrl", "slug", "title"]);
    assert.equal(first.playUrl, `https://${first.slug}.vibedgames.com`);
  });

  test("honours limit after ranking", () => {
    assert.equal(searchGames(featuredGames, { limit: 3 }).length, 3);
    const games: FeaturedGame[] = [
      { colorScheme: "dark", description: "A shooter.", name: "One", preview: "", slug: "one" },
      {
        colorScheme: "dark",
        description: "Shooter arena.",
        name: "Shooter",
        preview: "",
        slug: "two",
      },
    ];
    assert.deepEqual(
      searchGames(games, { limit: 1, query: "shooter" }).map((game) => game.slug),
      ["two"],
    );
  });

  test("every featured game carries a description", () => {
    for (const game of featuredGames) {
      assert.ok(game.description.length > 0, game.slug);
    }
  });
});

describe("serverInstructions", () => {
  test("names every tool and sends writes to the vg CLI", () => {
    for (const tool of ["get_started", "list_skills", "get_skill", "search_games"]) {
      assert.ok(serverInstructions.includes(tool), tool);
    }
    assert.match(serverInstructions, /vg CLI/u);
  });
});
