# fal Platform Notes

These notes summarize the official fal platform APIs that matter for image experiment tooling.

Primary docs used:

- `https://fal.ai/docs/documentation`
- `https://fal.ai/docs/documentation/model-apis/inference/client-setup`
- `https://docs.fal.ai/model-apis/model-endpoints/queue`
- `https://fal.ai/docs/platform-apis/v1/models`
- `https://fal.ai/docs/platform-apis/v1/models/pricing`
- `https://fal.ai/docs/platform-apis/v1/models/pricing/estimate`
- `https://fal.ai/docs/platform-apis/v1/models/usage`
- `https://fal.ai/docs/platform-apis/v1/models/requests/by-endpoint`

## Core Platform Surfaces

- Queue root: `https://queue.fal.run`
- Platform root: `https://api.fal.ai/v1`

## Queue Lifecycle

1. Submit to `POST /{endpoint_id}`
2. Poll `GET /{endpoint_id}/requests/{request_id}/status`
3. Fetch final result `GET /{endpoint_id}/requests/{request_id}`

This is the most useful pattern for experiments because it preserves:

- request ids
- pollable status
- raw JSON payloads
- consistent failure capture

## Helpful Headers

- `Authorization: Key <api key>`
- `X-Fal-Store-IO: 1`
- `x-app-fal-disable-fallback: true`

Useful response headers to record when present:

- `x-fal-request-id`
- `x-fal-billable-units`

## Cost Tracking Pattern

Use the platform APIs in two phases:

1. Pre-run estimate:
   - `POST /models/pricing/estimate`
2. Post-run audit:
   - `GET /models/requests/by-endpoint`
   - `GET /models/usage`

That gives both a predicted spend and a later reconciliation path.

## Why This Repo Uses Raw HTTP

fal's client libraries are valid, but the repo skill should stay:

- portable
- stdlib-friendly
- transparent about requests and payloads

The raw queue endpoints are enough for this.

