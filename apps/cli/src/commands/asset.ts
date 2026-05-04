import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import consola from "consola";

const PYTHON = process.env.PYTHON ?? "python3";
const DEFAULT_CELL_SIZE = "256";
const DEFAULT_FRAME_COUNT = "12";
const DEFAULT_OUT_DIR = "final_sprites";
const DEFAULT_WORK_DIR = ".vibedgames/asset-runs";

function scriptPath(name: string): string {
  const url = new URL(`../../asset-tools/${name}`, import.meta.url);
  if (!existsSync(url)) {
    consola.error(`Missing bundled asset tool: ${name}`);
    process.exit(1);
  }
  return fileURLToPath(url);
}

function runPython(name: string, args: string[]): Promise<void> {
  const child = spawn(PYTHON, [scriptPath(name), ...args], { stdio: "inherit" });
  return new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${name} exited with code ${code ?? 1}`));
    });
  });
}

async function runTool(name: string, args: string[]): Promise<void> {
  await runPython(name, args);
}

type ToolArg =
  | readonly [flag: string, value: string | undefined]
  | readonly [flag: string, value: boolean | undefined];

function toolArgs(entries: readonly ToolArg[]): string[] {
  const args: string[] = [];
  for (const [flag, value] of entries) {
    if (typeof value === "string" && value.length > 0) args.push(flag, value);
    if (value === true) args.push(flag);
  }
  return args;
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[:.]/g, "-");
}

function segment(value: string): string {
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (clean.length === 0) {
    consola.error("character and animation must contain at least one letter or number.");
    process.exit(1);
  }
  return clean;
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    consola.error(`${label} is required.`);
    process.exit(1);
  }
  return value;
}

type SpritePaths = {
  extractedDir: string;
  contactSheet: string;
  selectedDir: string;
  mattedDir: string;
  framesDir: string;
  sheet: string;
  preview: string;
  report: string;
  galleryManifest: string;
};

function spritePaths(input: {
  character: string;
  animation: string;
  frameCount: string;
  cellSize: string;
  runDir: string;
  outDir: string;
}): SpritePaths {
  const label = `${input.character}_${input.animation}_${input.frameCount}f_${input.cellSize}`;
  const animationRoot = join(input.outDir, input.character, input.animation);
  return {
    extractedDir: join(input.runDir, "extracted", input.character, input.animation),
    contactSheet: join(
      input.runDir,
      "contact_sheets",
      `${input.character}_${input.animation}_contact.png`,
    ),
    selectedDir: join(
      input.runDir,
      "selected",
      input.character,
      input.animation,
      `${input.frameCount}f`,
    ),
    mattedDir: join(
      input.runDir,
      "matted",
      input.character,
      input.animation,
      `${input.frameCount}f`,
    ),
    framesDir: join(animationRoot, "frames", `${input.frameCount}f_${input.cellSize}`),
    sheet: join(animationRoot, "sheets", `${label}.png`),
    preview: join(input.runDir, "previews", input.character, input.animation, `${label}_preview.png`),
    report: join(input.runDir, "reports", input.character, input.animation, `${label}_report.json`),
    galleryManifest: join(dirname(input.outDir), "sprite_gallery_manifest.js"),
  };
}

async function extractFrames(input: {
  video: string;
  outputDir: string;
  fps: string | undefined;
  overwrite: boolean | undefined;
}): Promise<void> {
  const report = join(input.outputDir, "extraction_report.json");
  if (existsSync(report) && input.overwrite !== true) {
    consola.info(`Using extracted frames: ${input.outputDir}`);
    return;
  }
  await runTool(
    "extract_frames_ffmpeg.py",
    toolArgs([
      ["--input", input.video],
      ["--output-dir", input.outputDir],
      ["--fps", input.fps],
      ["--overwrite", input.overwrite ?? existsSync(input.outputDir)],
    ]),
  );
}

async function makeContactSheet(sourceDir: string, output: string): Promise<void> {
  if (existsSync(output)) {
    consola.info(`Using contact sheet: ${output}`);
    return;
  }
  await runTool("make_contact_sheet.py", [
    "--source-dir",
    sourceDir,
    "--output",
    output,
    "--cols",
    "12",
    "--cell-size",
    "128",
    "--image-size",
    "112",
  ]);
}

async function selectFrames(input: {
  sourceDir: string;
  outputDir: string;
  indices: string;
  framePrefix: string;
  notes: string | undefined;
  overwrite: boolean | undefined;
}): Promise<void> {
  await runTool(
    "select_frames.py",
    toolArgs([
      ["--source-dir", input.sourceDir],
      ["--output-dir", input.outputDir],
      ["--indices", input.indices],
      ["--frame-prefix", input.framePrefix],
      ["--notes", input.notes],
      ["--overwrite", input.overwrite ?? existsSync(input.outputDir)],
    ]),
  );
}

async function matteLightBackground(input: {
  sourceDir: string;
  outputDir: string;
  framePrefix: string;
  overwrite: boolean | undefined;
}): Promise<void> {
  await runTool(
    "matte_light_background.py",
    toolArgs([
      ["--source-frames-dir", input.sourceDir],
      ["--output-dir", input.outputDir],
      ["--frame-prefix", input.framePrefix],
      ["--overwrite", input.overwrite ?? existsSync(input.outputDir)],
    ]),
  );
}

async function buildSheet(input: {
  sourceDir: string;
  frameCount: string;
  cellSize: string;
  framePrefix: string;
  output: string;
  preview: string;
  framesDir: string;
  report: string;
  backgroundMode: "chroma" | "alpha";
  clearRect: string | undefined;
}): Promise<void> {
  await runTool(
    "animation_pipeline.py",
    toolArgs([
      ["--source-frames-dir", input.sourceDir],
      ["--frames", input.frameCount],
      ["--output", input.output],
      ["--preview", input.preview],
      ["--frames-dir", input.framesDir],
      ["--report", input.report],
      ["--background-mode", input.backgroundMode],
      ["--layout-mode", "preserve-canvas"],
      ["--frame-prefix", input.framePrefix],
      ["--frame-size", input.cellSize],
      ["--clear-rect", input.clearRect],
    ]),
  );
}

async function buildGalleryManifest(outDir: string, output: string): Promise<void> {
  await runTool("build_sprite_gallery_manifest.py", [
    "--folder",
    outDir,
    "--output",
    output,
  ]);
}

type BackgroundMode = "chroma" | "alpha" | "light";

function parseBackground(value: string | undefined): BackgroundMode {
  if (value === undefined || value.length === 0) return "chroma";
  if (value === "chroma" || value === "alpha" || value === "light") return value;
  consola.error('--background must be "chroma", "alpha", or "light".');
  process.exit(1);
}

const spriteCommand = defineCommand({
  meta: {
    name: "sprite",
    description: "Turn one animation video into reviewed game-ready sprite assets.",
  },
  args: {
    video: { type: "string", required: true, description: "Source animation video." },
    character: { type: "string", required: true, description: "Character key." },
    animation: { type: "string", required: true, description: "Animation key." },
    indices: {
      type: "string",
      description: "1-based frames to promote. Omit to stop after contact sheet.",
    },
    frames: { type: "string", description: `Output frame count. Default ${DEFAULT_FRAME_COUNT}.` },
    notes: { type: "string", description: "Comma-separated beat labels for selected frames." },
    "out-dir": { type: "string", description: `Promoted sprite root. Default ${DEFAULT_OUT_DIR}.` },
    "run-dir": { type: "string", description: "Reusable work folder for this animation." },
    "work-dir": { type: "string", description: `Work root. Default ${DEFAULT_WORK_DIR}.` },
    "cell-size": { type: "string", description: `Output cell size. Default ${DEFAULT_CELL_SIZE}.` },
    background: { type: "string", description: "chroma, alpha, or light. Default chroma." },
    fps: { type: "string", description: "Optional constant FPS extraction." },
    "clear-rect": { type: "string", description: "Transparent cleanup rect x0,y0,x1,y1." },
    overwrite: { type: "boolean", description: "Replace existing work outputs." },
  },
  run: async ({ args }) => {
    const character = segment(required(args.character, "--character"));
    const animation = segment(required(args.animation, "--animation"));
    const video = resolve(required(args.video, "--video"));
    const frameCount = args.frames ?? DEFAULT_FRAME_COUNT;
    const cellSize = args["cell-size"] ?? DEFAULT_CELL_SIZE;
    const outDir = resolve(args["out-dir"] ?? DEFAULT_OUT_DIR);
    const workRoot = resolve(args["work-dir"] ?? DEFAULT_WORK_DIR);
    const runDir = resolve(
      args["run-dir"] ?? join(workRoot, `${timestamp()}_${character}_${animation}`),
    );
    const background = parseBackground(args.background);
    const paths = spritePaths({ character, animation, frameCount, cellSize, runDir, outDir });
    const framePrefix = `${character}_${animation}_${frameCount}f`;

    try {
      await extractFrames({
        video,
        outputDir: paths.extractedDir,
        fps: args.fps,
        overwrite: args.overwrite,
      });
      await makeContactSheet(paths.extractedDir, paths.contactSheet);

      if (args.indices === undefined || args.indices.length === 0) {
        consola.info(`Contact sheet: ${paths.contactSheet}`);
        consola.info(`Pick frames, then rerun with --run-dir ${runDir} --indices "..."`);
        return;
      }

      await selectFrames({
        sourceDir: paths.extractedDir,
        outputDir: paths.selectedDir,
        indices: args.indices,
        framePrefix,
        notes: args.notes,
        overwrite: args.overwrite,
      });

      const sheetSource =
        background === "light"
          ? paths.mattedDir
          : paths.selectedDir;
      if (background === "light") {
        await matteLightBackground({
          sourceDir: paths.selectedDir,
          outputDir: paths.mattedDir,
          framePrefix: `${framePrefix}_matted`,
          overwrite: args.overwrite,
        });
      }

      await buildSheet({
        sourceDir: sheetSource,
        frameCount,
        cellSize,
        framePrefix,
        output: paths.sheet,
        preview: paths.preview,
        framesDir: paths.framesDir,
        report: paths.report,
        backgroundMode: background === "chroma" ? "chroma" : "alpha",
        clearRect: args["clear-rect"],
      });
      await buildGalleryManifest(outDir, paths.galleryManifest);

      consola.success(`Sprite sheet: ${paths.sheet}`);
      consola.info(`Frames: ${paths.framesDir}`);
      consola.info(`Report: ${paths.report}`);
      consola.info(`Preview: ${paths.preview}`);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

export const assetCommand = defineCommand({
  meta: {
    name: "asset",
    description: "Prompt-friendly game asset tools.",
  },
  subCommands: {
    sprite: spriteCommand,
  },
});
