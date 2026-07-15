import { existsSync, readFileSync } from "node:fs";

import type { RoleName } from "./agents.ts";
import { headCommit } from "./git.ts";
import { readDirective, type AgentState, type Blackboard, type Phase } from "./state.ts";

export { ROLES } from "./agents.ts";
export type { Role, RoleName } from "./agents.ts";

/** Which subagent runs a given phase. `work` is routed dynamically. */
export function roleForPhase(phase: Phase, bb: Blackboard): RoleName {
  switch (phase) {
    case "spec":
      return "designer";
    case "scaffold":
    case "build":
      return "engineer";
    case "assets":
      return "artist";
    case "playtest":
      return "qa";
    case "ship":
      return "shipper";
    case "plan":
      return "director";
    case "work":
      return readNext(bb).role;
  }
}

type NextAssignment = { role: RoleName; type?: string; task: string };

function readNext(bb: Blackboard): NextAssignment {
  try {
    const parsed = JSON.parse(readFileSync(bb.next, "utf8")) as Partial<NextAssignment>;
    const role = parsed.role;
    if (role === "designer" || role === "engineer" || role === "artist" || role === "qa") {
      return { role, type: parsed.type, task: parsed.task ?? "" };
    }
  } catch {
    // fall through to default
  }
  return {
    role: "engineer",
    task: "next.json was missing or invalid — pick the highest-priority unfinished item from .agent/backlog.json and implement it.",
  };
}

/** The task ("user" turn) for a phase, grounded in current state. */
export function buildTask(phase: Phase, state: AgentState, bb: Blackboard): string {
  // A standing operator directive outranks everything else — the human is
  // steering; every subagent sees it until it changes.
  const directive = readDirective(bb);
  const steer = directive
    ? `OPERATOR DIRECTIVE — the human steering this game said: "${directive}". Honor it above other priorities until it changes.\n\n`
    : "";
  return `${steer}${phaseTask(phase, state, bb)}`;
}

function phaseTask(phase: Phase, state: AgentState, bb: Blackboard): string {
  const slug = state.slug;
  // Tell subagents to read the operator's brief/reference when one was given.
  const ctx = existsSync(bb.context)
    ? "First read ./.agent/context.md for the operator's brief / reference, and honor it. "
    : "";
  switch (phase) {
    case "spec":
      if (state.existingProject) {
        return `${ctx}The game directory ALREADY contains a project — build UPON it, don't start over. Read the existing source (package.json, src/, index.html, any README) to understand what it is and which engine/stack it uses. Then write ./.agent/spec.md describing the current game honestly and a concrete plan to finish/evolve it, and record the detected engine as a line exactly like \`engine: phaser\`, \`engine: threejs\`, or \`engine: other\`. Slug is "${slug}". Append a one-line summary to journal.md.`;
      }
      return `${ctx}Design the game from this seed idea: "${state.idea}".\nThe game slug is "${slug}". Produce ./.agent/spec.md per your role instructions, then append a one-line summary to journal.md.`;
    case "scaffold":
      if (state.existingProject) {
        return `${ctx}A project already exists in the current directory — do NOT run \`vg new\` (it would overwrite the existing code). Instead make it deployable: \`npm install\`, ensure \`npm run build\` and \`npm run typecheck\` succeed (add a typecheck script if missing), make sure a \`vibedgames.json\` with {"slug":"${slug}"} exists (\`vg deploy\` needs it), and add \`.agent/\` to .gitignore. Fix any build breakage. Append what you did to journal.md.`;
      }
      return `${ctx}Read ./.agent/spec.md for the engine choice. The current directory IS the game project root (it already contains the ./.agent folder). Scaffold the engine here by running \`vg new ${slug} --engine <phaser|threejs from spec> --here --force\`, then \`npm install\`. Confirm \`npm run build\` works on the fresh template. Append what you did to journal.md.`;
    case "assets": {
      const note = state.existingProject
        ? "The project may already ship art — only generate what's MISSING or what the spec calls for; never delete existing assets."
        : "This is the FIRST art pass — produce at least a hero, one enemy, one pickup, an impact VFX, and a background/tileset.";
      return `${ctx}Read ./.agent/spec.md and produce the art for "${slug}" per your role instructions. ${note} Record frame sizes and file paths in journal.md.`;
    }
    case "build": {
      const note = state.existingProject
        ? "Build upon the EXISTING code (don't rewrite it from scratch); wire in the generated assets and bring the core loop up to the spec."
        : "Implement movement, the central mechanic, win/lose, and the mandatory craft pass. This is the first playable — make the first 10 seconds feel good.";
      return `${ctx}Read ./.agent/spec.md. Get the core gameplay loop for "${slug}" working using the assets the artist generated (check journal.md for paths and frame sizes). ${note} Verify with typecheck + build.`;
    }
    case "playtest": {
      // Re-running the full committed suite at a HEAD that already passed a QA
      // turn is the single biggest recurring spend in a long loop — steer the
      // turn toward NEW coverage instead. (A hint, not a gate: QA still owns
      // the judgment, and any commit moves HEAD and re-arms the full suite.)
      const head = headCommit(bb.root);
      const unchanged = head !== null && head === state.lastPlaytestHead;
      const suiteNote = unchanged
        ? " The build is UNCHANGED since your last completed QA pass (same commit) — do NOT re-run the full committed regression suite; spend the turn on fresh exploratory testing (untested surfaces, edge cases, balance, feel) and only run the specific specs your exploration implicates."
        : "";
      return `Playtest the current build of "${slug}" per your role instructions and record findings in ./.agent/playtest.md and backlog.json.${suiteNote}`;
    }
    case "ship":
      return `Ship "${slug}". Build and \`vg deploy ./dist\`, then record the live URL in journal.md.`;
    case "plan": {
      const release = state.shipped
        ? `The game is live at ${state.deployUrl}.`
        : "The game has NOT been deployed yet (no live release) — favor getting it to a shippable first release.";
      return `Direct iteration ${state.iteration + 1} for "${slug}" like a studio. ${release} Read playtest.md and inspect the current game to gauge what it most needs now, triage ./.agent/backlog.json (ship-stoppers/bugs first, then the highest-impact feature / gameplay / balance / content / polish work for the game's current maturity — don't default to polish), and write ./.agent/next.json with the single most valuable next assignment.`;
    }
    case "work": {
      const next = readNext(bb);
      const kind = next.type ? ` [${next.type}]` : "";
      // The closing instruction must match the assigned subagent — engineer-only
      // guidance (fix the bug, mark the item done) would contradict QA/artist/designer.
      const close: Record<RoleName, string> = {
        engineer: `If it's a bug, reproduce it and fix the root cause; verify with typecheck + build. When done, set the item's status to "done" in backlog.json and append a 2–3 line note to journal.md.`,
        artist: `Generate/update the assets, place them where the game loads them, and record file paths + exact frame sizes. When done, set the item's status to "done" in backlog.json and append a note to journal.md naming the files.`,
        designer: `Append the design to the "Features & iterations" section of spec.md with crisp acceptance criteria. When done, set the item's status to "done" in backlog.json and append a note to journal.md.`,
        qa: `Playtest as described, record findings in ./.agent/playtest.md, and file/triage concrete items in backlog.json. Do NOT change game code — your output is findings; leave status updates to the director.`,
        director: "",
        shipper: "",
      };
      return `Current assignment from the director (./.agent/next.json)${kind}:\n\n${next.task}\n\nDo exactly this for "${slug}". ${close[next.role]}`;
    }
  }
}
