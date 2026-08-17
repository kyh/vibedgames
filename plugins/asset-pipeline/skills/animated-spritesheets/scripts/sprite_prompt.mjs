#!/usr/bin/env node
/**
 * Build the generation prompts for the two image steps.
 *
 *   anchor      one directional anchor sprite (the identity reference)
 *   pose-board  a grid of poses the pipeline slices into animation frames
 *
 * Examples:
 *   node sprite_prompt.mjs anchor --direction e --chroma '#00FF00'
 *   node sprite_prompt.mjs pose-board --action attack --direction e --frames 8
 *
 * Pass --guide-image only when you actually send a second reference image
 * alongside the anchor; it adds the "Image 2 role" clause to the prompt.
 */
import {
  fail,
  failUsage,
  getDirection,
  getFlag,
  getInt,
  getString,
  main,
  parseArgs,
  renderAnchorPrompt,
  renderPoseBoardPrompt,
  resolvePoseBoardPreset,
  totalCells,
  withStyle,
} from "./_lib/asset-tools.mjs";

const STYLE_CHOICES = ["lobit-v1", "high-fidelity-v1", "preserve-reference-v1"];

function styleOf(args) {
  const style = getString(args, "style");
  if (style !== undefined && !STYLE_CHOICES.includes(style)) {
    failUsage(
      `argument --style: invalid choice: '${style}' (choose from ${STYLE_CHOICES.map((c) => `'${c}'`).join(", ")})`,
    );
  }
  return style ?? null;
}

const COMMANDS = {
  anchor(args) {
    const direction = getString(args, "direction");
    if (!direction) failUsage("--direction is required (n,s,e,w,ne,nw,se,sw)");

    const prompt = renderAnchorPrompt(getDirection(direction), {
      gameView: getString(args, "game-view") ?? "platformer",
      anchorRole: getString(args, "role") ?? "character",
      anchorContext: getString(args, "anchor-context") ?? null,
      chroma: getString(args, "chroma") ?? "#00FF00",
      guideImage: getFlag(args, "guide-image"),
    });
    console.log(withStyle(prompt, styleOf(args)));
  },

  "pose-board"(args) {
    const action = getString(args, "action");
    const direction = getString(args, "direction");
    if (!action) failUsage("--action is required (e.g. attack, idle, walk)");
    if (!direction) failUsage("--direction is required (n,s,e,w,ne,nw,se,sw)");

    const framePromptStyle = getString(args, "frame-prompt-style") ?? "specific";
    if (framePromptStyle !== "specific" && framePromptStyle !== "loose") {
      failUsage(
        `argument --frame-prompt-style: invalid choice: '${framePromptStyle}' (choose from 'specific', 'loose')`,
      );
    }
    const board = resolvePoseBoardPreset(getString(args, "pose-board") ?? "standard");
    const frames = getInt(args, "frames", 0);
    if (frames <= 0) fail("--frames must be a positive integer");
    if (frames > totalCells(board)) {
      fail(
        `--frames ${frames} exceeds the ${board.id} board's ${totalCells(board)} cells; ` +
          "use fewer frames or a larger --pose-board",
      );
    }

    const prompt = renderPoseBoardPrompt(
      action.trim().toLowerCase(),
      getDirection(direction),
      frames,
      {
        poseBoard: board,
        framePromptStyle,
        chroma: getString(args, "chroma") ?? "#00FF00",
        guideImage: getFlag(args, "guide-image"),
      },
    );
    console.log(withStyle(prompt, styleOf(args)));
  },
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["guide-image"],
    values: [
      "action",
      "anchor-context",
      "chroma",
      "direction",
      "frame-prompt-style",
      "frames",
      "game-view",
      "pose-board",
      "role",
      "style",
    ],
  });
  const run = COMMANDS[args.positionals[0]];
  if (!run) failUsage("Usage: node sprite_prompt.mjs <anchor|pose-board> ...");
  run(args);
});
