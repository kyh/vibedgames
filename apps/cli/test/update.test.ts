import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { fetchLatestVersion, isNewerVersion } from "../src/lib/update.js";
import { makeCleanups, makeTestServer } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const LATEST = new Map([
  ["/@vibedgames/factory/latest", "0.1.1"],
  ["/vibedgames/latest", "0.8.0"],
]);

const useRegistry = async (): Promise<void> => {
  const port = await makeTestServer(cleanups, (req, res) => {
    const version = LATEST.get(req.url ?? "");
    res.writeHead(version ? 200 : 404, { "content-type": "application/json" });
    res.end(version ? JSON.stringify({ version }) : "{}");
  });
  const previous = process.env.VG_REGISTRY_URL;
  process.env.VG_REGISTRY_URL = `http://127.0.0.1:${port}`;
  cleanups.push(() => {
    if (previous === undefined) {
      delete process.env.VG_REGISTRY_URL;
    } else {
      process.env.VG_REGISTRY_URL = previous;
    }
  });
};

test("fetchLatestVersion asks the registry for the named package, scoped or not", async () => {
  await useRegistry();
  assert.equal(await fetchLatestVersion("vibedgames"), "0.8.0");
  assert.equal(await fetchLatestVersion("@vibedgames/factory"), "0.1.1");
});

test("fetchLatestVersion is null for a package the registry doesn't have", async () => {
  await useRegistry();
  assert.equal(await fetchLatestVersion("@vibedgames/missing"), null);
});

test("isNewerVersion compares each part numerically", () => {
  assert.equal(isNewerVersion("0.1.1", "0.1.0"), true);
  assert.equal(isNewerVersion("0.10.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
});
