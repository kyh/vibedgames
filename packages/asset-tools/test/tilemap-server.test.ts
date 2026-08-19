import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Bitmap } from "../src/image/raster.js";
import { createTilemapEditor, isInside } from "../src/asset/tilemap-server.js";

/**
 * A 4×2 tileset of solid colours with a 1px margin and 1px spacing, so the
 * server's crop math is exercised against non-trivial geometry rather than a
 * flush grid.
 */
function writeFixture(root: string) {
  const tileW = 8;
  const tileH = 8;
  const columns = 4;
  const rows = 2;
  const margin = 1;
  const spacing = 1;
  const sheet = Bitmap.create(
    margin * 2 + columns * tileW + (columns - 1) * spacing,
    margin * 2 + rows * tileH + (rows - 1) * spacing,
    [0, 0, 0, 0],
  );
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const id = r * columns + c + 1;
      const x0 = margin + c * (tileW + spacing);
      const y0 = margin + r * (tileH + spacing);
      for (let y = y0; y < y0 + tileH; y += 1) {
        for (let x = x0; x < x0 + tileW; x += 1) sheet.putPixel(x, y, [id * 20, 40, 60, 255]);
      }
    }
  }
  mkdirSync(join(root, "assets"), { recursive: true });
  sheet.toFile(join(root, "assets", "terrain.png"));

  const manifestPath = join(root, "assets_index.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      tilesets: {
        terrain: {
          path: "assets/terrain.png",
          tileWidth: tileW,
          tileHeight: tileH,
          columns,
          rows,
          margin,
          spacing,
        },
        // A second one, so tileset switching has somewhere to go.
        alt: {
          path: "assets/terrain.png",
          tileWidth: tileW,
          tileHeight: tileH,
          columns,
          rows,
          margin,
          spacing,
        },
      },
    }),
  );
  return { manifestPath };
}

const isAddressInfo = (value: string | AddressInfo | null): value is AddressInfo =>
  Object(value) === value;

let root: string;
let manifestPath: string;
let base: string;
let token: string;
let editor: ReturnType<typeof createTilemapEditor>;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "tilemap-editor-"));
  ({ manifestPath } = writeFixture(root));
  editor = createTilemapEditor({
    manifestPath,
    mapPath: join(root, "maps", "level1.json"),
    html: "<!doctype html><title>page</title>",
    writeRoot: root,
  });
  token = editor.token;
  await new Promise<void>((done) => editor.server.listen(0, "127.0.0.1", done));
  const address = editor.server.address();
  base = `http://127.0.0.1:${isAddressInfo(address) ? address.port : 0}`;
});

after(() => {
  editor.server.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...init.headers, "x-editor-token": token } });

// The endpoint shapes the tests read back. `Response.json()` is `unknown`, and
// naming what each route returns is more useful here than casting at each call.
type TilesetSummary = {
  name: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  margin: number;
  spacing: number;
};
type StateBody = {
  manifestPath: string;
  mapPath: string | null;
  tilesetNames: string[];
  tileset: TilesetSummary;
  map: { width: number; height: number; data: number[][]; tileset: string | null };
};
type MapBody = {
  path: string;
  width: number;
  height: number;
  data: number[][];
  tileset: string | null;
};
type ErrorBody = { error: string };

async function body<T>(response: Response): Promise<T> {
  // SAFETY: test-only boundary — each call site names the shape the route under
  // test must return, and the assertions that follow fail loudly on a mismatch.
  return (await response.json()) as T;
}

test("isInside accepts the root and its descendants only", () => {
  assert.equal(isInside("/srv/project", "/srv/project"), true);
  assert.equal(isInside("/srv/project", "/srv/project/maps/a.json"), true);
  assert.equal(isInside("/srv/project", "/srv/project/../project/x"), true);
  assert.equal(isInside("/srv/project", "/srv/other"), false);
  // A sibling sharing the root's name as a prefix must not pass.
  assert.equal(isInside("/srv/project", "/srv/project-old/x"), false);
  assert.equal(isInside("/srv/project", "/srv/project/../secrets"), false);
});

test("every route refuses a request without the token", async () => {
  for (const path of ["/", "/api/state", "/api/sheet?name=terrain"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 403, path);
  }
});

test("the page is served at the root", async () => {
  const response = await get("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /<title>page<\/title>/);
});

test("initial state describes the manifest, tilesets and an empty map", async () => {
  const state = await body<StateBody>(await get("/api/state"));
  assert.deepEqual(state.tilesetNames, ["alt", "terrain"]);
  assert.equal(state.tileset.name, "alt");
  assert.deepEqual(
    [state.tileset.columns, state.tileset.rows, state.tileset.margin, state.tileset.spacing],
    [4, 2, 1, 1],
  );
  // No map file yet, so the default canvas.
  assert.deepEqual([state.map.width, state.map.height], [64, 36]);
  assert.equal(state.map.data.length, 36);
  assert.ok(
    state.map.data.every((row: number[]) => row.length === 64 && row.every((v) => v === 0)),
  );
});

test("the sheet is served as image bytes", async () => {
  const response = await get("/api/sheet?name=terrain");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("an unknown tileset is a 400 with a message, not a crash", async () => {
  const response = await get("/api/tileset?name=nope");
  assert.equal(response.status, 400);
  assert.equal((await body<ErrorBody>(response)).error, "No such tileset: nope");
});

test("saving writes the map and creates missing directories", async () => {
  const data = Array.from({ length: 3 }, (_, y) => Array.from({ length: 4 }, (_, x) => y * 4 + x));
  const response = await get("/api/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tileset: "terrain", width: 4, height: 3, data }),
  });
  assert.equal(response.status, 200);

  const written = JSON.parse(readFileSync(join(root, "maps", "level1.json"), "utf8"));
  assert.deepEqual(written.meta, {
    version: 1,
    tileset: "terrain",
    tileWidth: 8,
    tileHeight: 8,
    width: 4,
    height: 3,
  });
  assert.deepEqual(written.data, data);
});

test("a saved map loads back with its tileset", async () => {
  const loaded = await body<MapBody>(
    await get(`/api/load?path=${encodeURIComponent("maps/level1.json")}`),
  );
  assert.deepEqual([loaded.width, loaded.height], [4, 3]);
  assert.equal(loaded.tileset, "terrain");
  assert.deepEqual(loaded.data[0], [0, 1, 2, 3]);
});

test("state follows the map file's own tileset once it exists", async () => {
  const state = await body<StateBody>(await get("/api/state"));
  assert.equal(state.tileset.name, "terrain");
  assert.deepEqual([state.map.width, state.map.height], [4, 3]);
});

test("a ragged or oversized payload is squared off rather than written through", async () => {
  await get("/api/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "maps/ragged.json",
      tileset: "terrain",
      width: 3,
      height: 3,
      // Short rows, a long row, a non-array row, and a non-numeric cell.
      data: [[1], [1, 2, 3, 4, 5], "nope", [null, 2.9, "x"]],
    }),
  });
  const written = JSON.parse(readFileSync(join(root, "maps", "ragged.json"), "utf8"));
  assert.equal(written.meta.width, 3);
  assert.equal(written.meta.height, 3);
  assert.deepEqual(written.data, [
    [1, 0, 0],
    [1, 2, 3],
    [0, 0, 0],
  ]);
});

test("dimensions are clamped to the supported range", async () => {
  await get("/api/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "maps/huge.json",
      tileset: "terrain",
      width: 99999,
      height: 0,
      data: [],
    }),
  });
  const written = JSON.parse(readFileSync(join(root, "maps", "huge.json"), "utf8"));
  assert.deepEqual([written.meta.width, written.meta.height], [512, 1]);
  assert.equal(written.data.length, 1);
  assert.equal(written.data[0].length, 512);
});

test("writes and reads outside the root are refused", async () => {
  for (const path of ["../escape.json", "/etc/passwd", "maps/../../escape.json"]) {
    const save = await get("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, tileset: "terrain", width: 1, height: 1, data: [[1]] }),
    });
    assert.equal(save.status, 400, `save ${path}`);
    assert.match((await body<ErrorBody>(save)).error, /Refusing to touch a path outside/);

    const load = await get(`/api/load?path=${encodeURIComponent(path)}`);
    assert.equal(load.status, 400, `load ${path}`);
  }
});

test("an unknown endpoint is a 404 with a message", async () => {
  const response = await get("/api/nope");
  assert.equal(response.status, 404);
  assert.match((await body<ErrorBody>(response)).error, /No such endpoint/);
});

test("the printed URL carries the token", () => {
  assert.equal(editor.url(4321), `http://127.0.0.1:4321/?t=${token}`);
});
