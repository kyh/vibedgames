# ElevenLabs API Patterns

Use this reference when the task needs concrete implementation direction after architectural choices are set.

## Auth and Secret Handling

- API key header: `xi-api-key`.
- Environment variable convention: `ELEVENLABS_API_KEY`.
- Preferred architecture: backend performs privileged ElevenLabs requests.
- If client-side calls are required, broker short-lived scoped tokens from backend.

## Endpoint Selection Heuristic

- Batch text-to-speech endpoint: best for reusable lines, exports, narrative content, and asset pipelines.
- Streaming text-to-speech endpoint: best for interactive dialogue and low time-to-first-audio UX.
- Speech-to-text endpoint: use only when user audio transcription is required.

## Model and Voice Selection Workflow

1. Start from product intent: narration, assistant, character, or utility prompts.
2. Pick `voice_id` by persona fit and intelligibility.
3. Pick `model_id` by latency/quality target.
4. Pin defaults in config, not scattered literals.
5. Run A/B listening tests before rollout.

## Minimal Node Server Pattern

```js
import ElevenLabs from '@elevenlabs/elevenlabs-js';

const elevenlabs = new ElevenLabs({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

export async function synthesize({ text, voiceId, modelId, outputFormat }) {
  return elevenlabs.textToSpeech.convert(voiceId, {
    text,
    model_id: modelId,
    output_format: outputFormat,
  });
}
```

Implementation notes:
- Validate input text length and required ids before API call.
- Enforce timeout and retry policy at call site.
- Persist result using cache key derived from text + voice + model + format.

## Cache-Key Normalization

Use a canonical text transform before hashing:
- Trim outer whitespace.
- Normalize repeated spaces/newlines.
- Standardize punctuation variants if your content source is noisy.

Then key on:
- normalizedText
- voiceId
- modelId
- outputFormat
- relevant tuning fields

## Operational Guardrails

- Track: request count, p50/p95 latency, error rates, cache-hit rate.
- Log request metadata without sensitive key material.
- Alert on sustained generation failures or latency regressions.
- Keep a fallback voice/model map per feature.

## Debugging Checklist

- 401/403: verify header and environment key source.
- Empty or invalid audio: verify output format compatibility with playback stack.
- High latency: move long lines to pre-generation and increase cache hit rate.
- Robotic pacing: split long text into semantic chunks and tune per chunk type.
