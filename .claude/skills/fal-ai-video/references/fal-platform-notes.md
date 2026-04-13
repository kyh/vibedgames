# fal Platform Notes

These notes are intentionally narrow: only the pieces needed for media experimentation in this repo.

## Core Docs

- Documentation: https://fal.ai/docs/documentation
- Client setup: https://fal.ai/docs/documentation/model-apis/inference/client-setup
- Platform headers: https://fal.ai/docs/documentation/model-apis/common-parameters
- Model search: https://fal.ai/docs/platform-apis/v1/models
- Pricing: https://fal.ai/docs/platform-apis/v1/models/pricing
- Estimate cost: https://fal.ai/docs/platform-apis/v1/models/pricing/estimate
- Usage: https://fal.ai/docs/platform-apis/v1/models/usage
- Analytics: https://fal.ai/docs/platform-apis/v1/models/analytics
- Requests by endpoint: https://fal.ai/docs/platform-apis/v1/models/requests/by-endpoint

## Authentication

- Queue and platform APIs use `Authorization: Key YOUR_API_KEY`.
- Server-side setup uses `FAL_KEY`.
- Keep the key server-side only. Do not expose it in browser code.

## Platform Headers That Matter Here

From the Platform Headers doc:

- `X-Fal-Store-IO`
  - enables request payload persistence needed for later request-audit workflows
- `x-app-fal-disable-fallback`
  - disables fallback routing so strict model comparisons actually hit the requested endpoint
- `X-Fal-Request-Timeout`
  - useful when queue wait behavior needs tighter control

Important response headers:

- `x-fal-request-id`
- `x-fal-billable-units`
- `x-fal-served-from`

## Cost Surfaces

fal exposes several complementary cost signals:

- `/models/pricing`
  - live unit pricing for endpoints
- `/models/pricing/estimate`
  - pre-run cost estimation
- `/models/usage`
  - post-run usage summaries including quantity, unit price, and computed cost
- `/models/requests/by-endpoint`
  - request audit trail for request IDs and timestamps

This repo should record both:

- a pre-run estimate
- a post-run reconciliation signal

## Why The Skill Uses Queue + Platform APIs Together

Queue APIs answer:

- was the request submitted
- what is the request ID
- is it complete
- where is the final payload

Platform APIs answer:

- what did this endpoint cost
- what requests ran in a given window
- how should we compare models over time

