import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { RecipeTool } from "@repo/contract/asset/recipe-schema";

/** Where each program a recipe calls lives; absent when it is not installed. */
export interface Tools {
  blender?: string;
  ffmpeg?: string;
  ffprobe?: string;
  gltfTransform?: string;
  img2threejs?: string;
  python?: string;
  tar?: string;
  uv?: string;
}

const EXTENSIONS = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Finds a program on PATH, as a shell would. */
export const which = (name: string) =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => EXTENSIONS.map((ext) => path.join(dir, name + ext)))
    .find(isFile);

const BLENDER_APPS = [
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "C:\\Program Files\\Blender Foundation\\Blender\\blender.exe",
];

const findBlender = () => {
  const configured = process.env.BLENDER_PATH;

  return configured !== undefined && configured !== "" && isFile(configured)
    ? configured
    : (which("blender") ?? BLENDER_APPS.find(isFile));
};

const findImg2threejs = () => {
  const root = process.env.IMG2THREEJS_HOME ?? path.join(homedir(), ".local/share/img2threejs");

  return existsSync(path.join(root, "forge")) ? root : undefined;
};

/** The programs installed on this machine that recipes can use. */
export const findTools: () => Tools = () => ({
  blender: findBlender(),
  ffmpeg: which("ffmpeg"),
  ffprobe: which("ffprobe"),
  gltfTransform: which("gltf-transform"),
  img2threejs: findImg2threejs(),
  python: which("python3") ?? which("python"),
  tar: which("tar"),
  uv: which("uv"),
});

/** Whether every tool a recipe needs is on this machine. */
export const hasTools = (tools: Tools, needs: readonly RecipeTool[]) =>
  needs.every((tool) => {
    switch (tool) {
      case "blender": {
        return tools.blender !== undefined;
      }

      case "ffmpeg": {
        return tools.ffmpeg !== undefined && tools.ffprobe !== undefined;
      }

      case "gltf-transform": {
        return tools.gltfTransform !== undefined;
      }

      case "img2threejs": {
        return tools.img2threejs !== undefined && (tools.uv ?? tools.python) !== undefined;
      }

      default: {
        return false;
      }
    }
  });
