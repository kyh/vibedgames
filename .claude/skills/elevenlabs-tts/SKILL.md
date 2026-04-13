---
name: elevenlabs-tts
description: "Build and troubleshoot ElevenLabs text-to-speech integrations in Node/Python/web apps: auth, voice/model selection, streaming vs batch generation, latency, fallback handling, and secure API-key architecture."
metadata:
  short-description: "Pragmatic ElevenLabs TTS implementation framework."
---

# ElevenLabs TTS

Use this skill when implementing or debugging ElevenLabs text-to-speech in production code. It emphasizes architecture decisions first, then API usage.

## Philosophy: Speech Is a Product Surface

TTS is not just an API call; it is a UX contract across identity, latency, intelligibility, and reliability.

**Before implementing, ask**:
- Is this interaction realtime, near-realtime, or offline pre-generation?
- What matters most here: naturalness, speed, cost, or deterministic reproducibility?
- Where is the trust boundary, and how are API credentials protected?
- What fallback should happen if voice generation fails or times out?

**Core principles**:
1. Delivery-first design: Choose pipeline and endpoint from latency/quality targets, not preference.
2. Secrets never in clients: API keys belong server-side; clients get short-lived scoped tokens when needed.
3. Deterministic contracts: Standardize request and response shapes so retries and caching are safe.
4. Graceful degradation: Always define timeout, retry, and fallback behavior before shipping.

## Activation Cues

Use this skill when requests involve:
- ElevenLabs API quickstart/authentication.
- Text-to-speech generation in Node.js, Python, browser, or mobile wrappers.
- Choosing `voice_id`, `model_id`, `output_format`, and latency strategies.
- Moving from local demos to production-safe architecture.
- Reducing clipping, unnatural cadence, or slow response time.

## Decision Framework

### 1. Choose Generation Mode

- Batch generation: Prefer for narration, static prompts, cutscenes, and reusable assets.
- Streaming generation: Prefer for conversational UX where time-to-first-audio is critical.
- Hybrid: Pre-generate common lines; stream only dynamic lines.

### 2. Choose Quality/Latency Strategy

- Priority = responsiveness: use lower-latency path and smaller payloads.
- Priority = quality: use higher-quality models and post-process/caching.
- Priority = repeatability: pin model/version and reuse cached assets by content hash.

### 3. Choose Integration Boundary

- Server-generated audio (recommended default): backend calls ElevenLabs, returns audio URL/bytes.
- Tokenized client access: backend mints short-lived token for constrained client-side calls.
- Offline pipeline: content build step generates files into static/public assets.

## Implementation Workflow

### 1. Define an explicit contract

Use a stable input model, for example:
- `text`
- `voiceId`
- `modelId`
- `outputFormat`
- Optional tuning fields (only what product needs)

Return a stable output model, for example:
- `audioUrl` or base64/blob reference
- `mimeType`
- `durationMs` (if known)
- `cacheHit`

### 2. Build secure API access

- Store key in environment variable (`ELEVENLABS_API_KEY`).
- Never hardcode or ship keys in frontend bundles.
- For direct-client patterns, mint short-lived, minimally scoped tokens from backend.

### 3. Implement retries and fallback

- Retry transient failures with short bounded backoff.
- Set request timeout; fail fast enough for UX context.
- Fallback options include returning cached previous audio.
- Fallback options include degrading to a backup voice/model.
- Fallback options include showing text-only UX when audio is unavailable.

### 4. Add caching intentionally

- Cache key: hash of normalized text + voice + model + output format.
- Use immutable audio URLs where possible.
- Bust cache only when voice/model or normalization rules change.

### 5. Validate with perceptual checks

- Verify pronunciation of names/domain terms.
- Check clipping, pacing, and sentence boundary pauses.
- Validate mobile/network behavior for slow links.

## Anti-Patterns To Avoid

❌ **API key in frontend code**
Why bad: key leakage and account abuse risk.
Better: route all privileged calls through backend or token broker.

❌ **One-size-fits-all voice settings**
Why bad: unnatural output across contexts (alerts vs narration vs dialogue).
Better: maintain per-use-case presets.

❌ **No timeout or fallback path**
Why bad: blocked UX and brittle flows.
Better: strict timeout + deterministic fallback behavior.

❌ **Re-generating identical text repeatedly**
Why bad: wasted cost and latency.
Better: content-hash caching and reuse.

❌ **Conflating latency and quality tuning**
Why bad: random changes without measurable gains.
Better: test one variable at a time with explicit success metrics.

## Variation Guidance

**IMPORTANT**: Implementations should vary by product context.

- Vary voice persona by role: narrator, assistant, NPC, system alert.
- Vary output format by channel: web streaming, downloadable assets, mobile playback constraints.
- Vary fallback policies by feature criticality.
- Vary chunking strategy for long-form text vs short conversational lines.

Avoid converging on a single default voice/model for every task.

## References

- API patterns and endpoint selection: `references/api-patterns.md`

## Remember

Design the speech pipeline around UX and operational constraints first. The API call is the easy part; production behavior is the real task.

Codex can do extraordinary work in this domain. Use these principles to unlock better decisions, adapt to context, and ship robust voice experiences.
