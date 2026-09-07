import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const KEYS = ["buckler", "blade", "bowstring", "fire", "mechanism", "potion"];
const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/render/foley.ts", import.meta.url), "utf8"),
).replace(/^export /gm, "");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
function fixture() {
  const requests = [],
    decodes = [];
  const fetch = (url, { signal }) => {
    const result = deferred();
    requests.push({ ...result, url, signal });
    // Deliberately ignore abort here, proving stale fulfillment is fenced even
    // when transport/body completion races with the native abort signal.
    return result.promise;
  };
  const context = {
    state: "suspended",
    decodeAudioData: (bytes) => {
      const result = deferred();
      decodes.push({ ...result, bytes });
      return result.promise;
    },
    createBufferSource() {
      throw Error("Foley cache must never own playback");
    },
  };
  const FoleyBank = new Function("fetch", `${source};return FoleyBank;`)(fetch);
  return { bank: new FoleyBank(), context, requests, decodes };
}
const response = (bytes = new ArrayBuffer(4)) => ({ ok: true, arrayBuffer: async () => bytes });

test("idle/closed-context cache is inert; prime returns immediately and starts exactly six loads once", async () => {
  const f = fixture();
  assert.equal(f.bank.diagnostics().status, "idle");
  assert.equal(f.bank.diagnostics().blocked, true);
  assert.ok(KEYS.every((key) => f.bank.buffer(key) === null));
  f.bank.prime({ state: "closed" });
  assert.equal(f.requests.length, 0);
  assert.equal(f.bank.prime(f.context), undefined);
  for (let i = 0; i < 100; i++) f.bank.prime(f.context);
  assert.equal(f.requests.length, 6);
  assert.equal(new Set(f.requests.map((r) => r.signal)).size, 1);
  assert.deepEqual(
    f.requests.map((r) => r.url),
    KEYS.map((key) => `audio/foley/${key}.ogg`),
  );
  assert.equal(f.bank.diagnostics().pending, 6);
  assert.ok(
    KEYS.every((key) => f.bank.buffer(key) === null),
    "missed cues have immediate fallback",
  );
  // A second context cannot silently replace a bank already bound to the mixer.
  f.bank.prime({
    state: "running",
    decodeAudioData() {
      throw Error("wrong context");
    },
  });
  for (const request of f.requests) request.resolve(response());
  await settle();
  assert.equal(f.decodes.length, 6);
  const buffers = KEYS.map((key) => ({ key }));
  f.decodes.forEach((decode, i) => decode.resolve(buffers[i]));
  await settle();
  assert.equal(f.bank.diagnostics().status, "ready");
  for (let i = 0; i < KEYS.length; i++) assert.equal(f.bank.buffer(KEYS[i]), buffers[i]);
  assert.equal(f.requests.length, 6);
  assert.equal(f.decodes.length, 6);
  assert.ok(Object.isFrozen(f.bank.diagnostics()));
  assert.ok(Object.isFrozen(f.bank.diagnostics().entries));
  f.bank.dispose();
  assert.ok(KEYS.every((key) => f.bank.buffer(key) === null));
});
test("HTTP, transport, body and decode errors preserve partial success without frame-driven retries", async () => {
  const f = fixture();
  f.bank.prime(f.context);
  f.requests[0].resolve({
    ok: false,
    arrayBuffer() {
      throw Error("HTTP error body must not decode");
    },
  });
  f.requests[1].reject(Error("blocked fetch"));
  f.requests[2].resolve({
    ok: true,
    arrayBuffer: async () => {
      throw Error("body failure");
    },
  });
  for (const request of f.requests.slice(3)) request.resolve(response());
  await settle();
  f.decodes[0].reject(Error("invalid codec"));
  f.decodes[1].resolve({ key: "mechanism" });
  f.decodes[2].resolve({ key: "potion" });
  await settle();
  assert.deepEqual(f.bank.diagnostics(), {
    status: "partial",
    ready: 2,
    pending: 0,
    failed: 4,
    blocked: false,
    entries: {
      buckler: "http-error",
      blade: "fetch-error",
      bowstring: "fetch-error",
      fire: "decode-error",
      mechanism: "ready",
      potion: "ready",
    },
  });
  for (let i = 0; i < 100; i++) {
    f.bank.prime(f.context);
    for (const key of KEYS) f.bank.buffer(key);
  }
  assert.equal(f.requests.length, 6);
  assert.equal(f.decodes.length, 3);
  assert.equal(f.bank.buffer("fire"), null);
  f.bank.dispose();
});
test("dispose aborts all pending fetches once; late responses and later prime cannot restart decoding", async () => {
  const f = fixture();
  f.bank.prime(f.context);
  let aborted = 0;
  f.requests[0].signal.addEventListener("abort", () => aborted++);
  f.bank.dispose();
  f.bank.dispose();
  assert.equal(aborted, 1);
  assert.ok(f.requests.every((request) => request.signal.aborted));
  for (const request of f.requests) request.resolve(response());
  await settle();
  f.bank.prime(f.context);
  assert.equal(f.decodes.length, 0);
  assert.equal(f.requests.length, 6);
  assert.equal(f.bank.diagnostics().status, "disposed");
  assert.equal(f.bank.diagnostics().ready, 0);
  assert.ok(KEYS.every((key) => f.bank.buffer(key) === null));
});
test("pending body/decode completion cannot retain buffers after final disposal", async () => {
  const f = fixture();
  f.bank.prime(f.context);
  const body = deferred();
  f.requests[0].resolve({ ok: true, arrayBuffer: () => body.promise });
  for (const request of f.requests.slice(1)) request.resolve(response());
  await settle();
  assert.equal(f.decodes.length, 5);
  f.decodes[0].resolve({ key: "blade" });
  await settle();
  const before = f.bank.diagnostics();
  assert.equal(before.ready, 1);
  f.bank.dispose();
  body.resolve(new ArrayBuffer(4));
  f.decodes[1].reject(Error("context closed during decode"));
  for (const decode of f.decodes.slice(2)) decode.resolve({ late: true });
  await settle();
  assert.equal(f.decodes.length, 5, "disposed body must not start the sixth decode");
  assert.deepEqual([f.bank.diagnostics().ready, f.bank.diagnostics().pending], [0, 0]);
  assert.equal(before.ready, 1, "diagnostic snapshot is stable");
  assert.ok(KEYS.every((key) => f.bank.buffer(key) === null));
});
test("complete load failure and disposing an idle bank remain source-free and permanently quiet", async () => {
  const f = fixture();
  f.bank.prime(f.context);
  for (const request of f.requests) request.reject(Error("offline"));
  await settle();
  assert.equal(f.bank.diagnostics().status, "failed");
  assert.equal(f.bank.diagnostics().failed, 6);
  assert.equal(f.bank.diagnostics().blocked, true);
  assert.equal(f.decodes.length, 0);
  const idle = fixture();
  idle.bank.dispose();
  idle.bank.prime(idle.context);
  assert.equal(idle.requests.length, 0);
  assert.equal(idle.bank.diagnostics().status, "disposed");
  f.bank.dispose();
});
