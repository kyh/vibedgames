import type { FeaturedGame } from "@/components/game/data";
import type { SkillIndexEntry } from "@/lib/agent-skills";
import { gameUrl } from "@/components/game/data";
import { siteConfig } from "@/lib/site-config";

/**
 * The pure half of the `/mcp` server: search, shaping and copy. The route only
 * wires these to the SDK, so everything an agent sees is testable without a
 * Worker.
 */

export interface SkillEntry {
  slug: string;
  description: string;
  url: string;
}

export interface GameEntry {
  slug: string;
  title: string;
  description: string;
  playUrl: string;
}

interface Searchable {
  /** Matched first: a hit here outranks any number of description-only hits per token. */
  names: string[];
  description: string;
}

const tokenize = (query: string): string[] => query.toLowerCase().split(/\s+/u).filter(Boolean);

const tokenScore = ({ names, description }: Searchable, token: string): number => {
  if (names.some((name) => name.toLowerCase().includes(token))) {
    return 2;
  }
  return description.toLowerCase().includes(token) ? 1 : 0;
};

/**
 * Tokens are OR'd and summed rather than AND'd: an agent's query describes
 * intent ("pixel art walk cycle"), and one missing word should rank an item
 * lower, not drop it. Ties keep input order. An empty query returns everything.
 */
export const rankByQuery = <T>(
  items: readonly T[],
  query: string | undefined,
  searchable: (item: T) => Searchable,
): T[] => {
  const tokens = tokenize(query ?? "");
  if (tokens.length === 0) {
    return [...items];
  }
  return items
    .map((item) => ({
      item,
      score: tokens.reduce((sum, token) => sum + tokenScore(searchable(item), token), 0),
    }))
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score)
    .map(({ item }) => item);
};

/** Takes the `.well-known/agent-skills` index entries, so both surfaces list the same thing. */
export const searchSkills = (skills: readonly SkillIndexEntry[], query?: string): SkillEntry[] =>
  rankByQuery(skills, query, (skill) => ({
    description: skill.description,
    names: [skill.name],
  })).map((skill) => ({ description: skill.description, slug: skill.name, url: skill.url }));

export const searchGames = (
  games: readonly FeaturedGame[],
  { query, limit }: { query?: string; limit: number },
): GameEntry[] =>
  rankByQuery(games, query, (game) => ({
    description: game.description,
    names: [game.name, game.slug],
  }))
    .slice(0, limit)
    .map((game) => ({
      description: game.description,
      playUrl: gameUrl(game.slug),
      slug: game.slug,
      title: game.name,
    }));

export const serverInstructions = [
  `${siteConfig.name} is an agent-native platform for building, hosting and shipping browser games: the vg CLI plus bundled game-studio skills scaffold a game, generate art and audio, add real-time multiplayer, and deploy it to {slug}.vibedgames.com.`,
  "Call get_started first for the install steps.",
  "Use list_skills to find the craft guide for the job at hand (Phaser, Three.js, pixel art, game feel, multiplayer, deploy, ...) and get_skill to read one in full; search_games lists shipped games to play or learn from.",
  "With a vibedgames account (sign in, or a vg_ API key as a Bearer token) the generate_* tools make images, video, audio and 3D (models → schema → submit → status → result), and the deploy_* tools publish and manage games.",
  "Scaffolding a project and uploading a local build folder go through the vg CLI.",
].join(" ");
