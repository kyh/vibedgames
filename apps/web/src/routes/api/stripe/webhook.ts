import { handleStripeWebhook } from "@repo/service/credits/stripe";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";

/**
 * Stripe's webhook endpoint: the only path that credits a purchase. Not an
 * oRPC route — Stripe signs the raw body, so `handleStripeWebhook` reads it
 * untouched and verifies `Stripe-Signature` before trusting a byte.
 */
export const Route = createFileRoute("/api/stripe/webhook")({
  server: {
    handlers: {
      POST: ({ request }) => {
        const { billing, db } = getServerContext();
        return handleStripeWebhook(request, { billing, db });
      },
    },
  },
});
