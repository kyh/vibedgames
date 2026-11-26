import { runInOrder } from "@repo/contract/run-in-order";
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { startD1 } from "../d1.test-utils";
import type { PurchaseInput } from "./credit-ledger";
import { handleStripeWebhook, purchasesEnabled, verifyStripeSignature } from "./stripe";

const SECRET = "whsec_test";

const sign = async (payload: string, timestamp: number, secret = SECRET) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );

  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return `t=${timestamp},v1=${hex}`;
};

const nowS = () => Math.floor(Date.now() / 1000);

const paidSession = {
  amount_total: 2500,
  client_reference_id: "user-1",
  currency: "usd",
  id: "cs_test_1",
  metadata: { creditMicro: "25000000", userId: "user-1" },
  payment_status: "paid",
};

type Session = Omit<Partial<typeof paidSession>, "metadata"> & {
  metadata?: Partial<(typeof paidSession)["metadata"]>;
};

const event = (type: string, object: Session = paidSession) =>
  JSON.stringify({ data: { object }, id: "evt_1", type });

const d1 = await startD1();

after(d1.close);

const { db } = d1;

const deliver = async (payload: string, signature?: string) => {
  const credited: PurchaseInput[] = [];

  const res = await handleStripeWebhook(
    new Request("https://vibedgames.com/api/stripe/webhook", {
      body: payload,
      headers: { "stripe-signature": signature ?? (await sign(payload, nowS())) },
      method: "POST",
    }),
    { billing: { stripeWebhookSecret: SECRET }, db },
    async (_db, input) => {
      credited.push(input);

      return await Promise.resolve(true);
    },
  );

  return { credited, status: res.status };
};

describe("verifyStripeSignature", () => {
  test("accepts its own signature and any matching v1 among several", async () => {
    const t = nowS();
    const header = await sign("{}", t);
    assert.equal(await verifyStripeSignature(SECRET, header, "{}", t), true);
    const rolled = `t=${t},v1=${"0".repeat(64)},${header.split(",")[1]}`;
    assert.equal(await verifyStripeSignature(SECRET, rolled, "{}", t), true);
  });

  test("refuses a tampered payload, a wrong secret, a stale timestamp and junk", async () => {
    const t = nowS();
    const header = await sign("{}", t);
    assert.equal(await verifyStripeSignature(SECRET, header, '{"x":1}', t), false);
    assert.equal(await verifyStripeSignature("whsec_other", header, "{}", t), false);
    assert.equal(await verifyStripeSignature(SECRET, header, "{}", t + 301), false);
    assert.equal(await verifyStripeSignature(SECRET, "garbage", "{}", t), false);
  });
});

describe("handleStripeWebhook", () => {
  test("credits a paid checkout once, from its own metadata", async () => {
    const { credited, status } = await deliver(event("checkout.session.completed"));
    assert.equal(status, 200);
    assert.deepEqual(credited, [
      { checkoutSessionId: "cs_test_1", creditMicro: 25_000_000, userId: "user-1" },
    ]);
  });

  test("credits a delayed payment when it succeeds, not when the session completes", async () => {
    const unpaid = { ...paidSession, payment_status: "unpaid" };
    const early = await deliver(event("checkout.session.completed", unpaid));
    assert.deepEqual(early.credited, []);
    const later = await deliver(event("checkout.session.async_payment_succeeded"));
    assert.equal(later.credited.length, 1);
  });

  test("refuses an unsigned or forged delivery without crediting", async () => {
    const payload = event("checkout.session.completed");
    const forged = await deliver(payload, await sign(payload, nowS(), "whsec_attacker"));
    assert.equal(forged.status, 400);
    assert.deepEqual(forged.credited, []);
    const unsigned = await deliver(payload, "");
    assert.equal(unsigned.status, 400);
  });

  test("acknowledges, without crediting, events and sessions that aren't ours", async () => {
    const cases = [
      event("payment_intent.succeeded"),
      event("checkout.session.completed", { ...paidSession, metadata: {} }),
      event("checkout.session.completed", { ...paidSession, client_reference_id: "user-2" }),
      event("checkout.session.completed", { ...paidSession, currency: "eur" }),
    ];

    await runInOrder(cases, async (payload) => {
      const { credited, status } = await deliver(payload);
      assert.equal(status, 200);
      assert.deepEqual(credited, []);
    });
  });

  test("answers 412 when no webhook secret is configured", async () => {
    const res = await handleStripeWebhook(
      new Request("https://vibedgames.com/api/stripe/webhook", { body: "{}", method: "POST" }),
      { billing: undefined, db },
    );

    assert.equal(res.status, 412);
  });
});

describe("purchasesEnabled", () => {
  test("opens purchases only with both keys: either alone would take money it can't credit", () => {
    assert.equal(purchasesEnabled({}), false);
    assert.equal(purchasesEnabled({ stripeSecretKey: "sk_test" }), false);
    assert.equal(purchasesEnabled({ stripeWebhookSecret: SECRET }), false);
    assert.equal(purchasesEnabled({ stripeSecretKey: "", stripeWebhookSecret: SECRET }), false);
    assert.equal(
      purchasesEnabled({ stripeSecretKey: "sk_test", stripeWebhookSecret: SECRET }),
      true,
    );
  });
});
