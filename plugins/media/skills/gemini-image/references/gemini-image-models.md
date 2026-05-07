# Gemini Image Models — API Notes

This reference is intentionally narrow: only the parts needed to use Gemini image models well from the API.

Source: https://ai.google.dev/gemini-api/docs/image-generation

## Endpoint

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
Header: x-goog-api-key: $GEMINI_API_KEY
```

The same endpoint that serves text Gemini also returns images when `generationConfig.responseModalities` includes `"IMAGE"`.

## Model IDs

| Model ID | Tier | Notes |
|---|---|---|
| `gemini-3-pro-image-preview` | Pro | Thinking on by default. Premium quality, complex layouts. |
| `gemini-3.1-flash-image-preview` | Flash | Best all-around. Most aspect ratios, most reference images. |
| `gemini-2.5-flash-image` | Flash (Nano Banana) | Speed and cost optimized. 1K cap. |

All three are accessed through the same endpoint and request schema.

## Request Schema

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "prompt string" },
        { "inline_data": { "mime_type": "image/png", "data": "<base64>" } }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": {
      "aspectRatio": "16:9",
      "imageSize": "2K"
    },
    "thinkingConfig": {
      "thinkingLevel": "High",
      "includeThoughts": false
    }
  },
  "tools": [{ "google_search": {} }]
}
```

Field notes:

- `responseModalities`: must include `"IMAGE"`. `"TEXT"` is optional but commonly included so the model can return a short caption alongside the image.
- `imageConfig.aspectRatio`: pick from the supported list per model (below). Defaults vary; specifying explicitly is safer.
- `imageConfig.imageSize`: `"512"` / `"0.5K"` (3.1 Flash only), `"1K"`, `"2K"` (3.x only), `"4K"` (3.x only).
- `thinkingConfig.thinkingLevel`: `"minimal"` or `"High"`. 3 Pro defaults to thinking on.
- `thinkingConfig.includeThoughts`: surface thought signatures in the response. Tokens are billed regardless.
- `tools`: add `{ "google_search": {} }` for grounding. 3.1 Flash supports both web and image search; 3 Pro and 2.5 Flash support web only.

## Response Schema

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          { "text": "short description" },
          { "inline_data": { "mime_type": "image/png", "data": "<base64>" } },
          { "thought_signature": "..." }
        ]
      },
      "groundingMetadata": {
        "searchEntryPoint": { "rendered_content": "<html>" },
        "groundingChunks": [{ "uri": "https://..." }]
      }
    }
  ]
}
```

The image is always returned as base64 in `inline_data.data`. Decode and write to disk with the matching extension from `mime_type`.

## Aspect Ratios

`gemini-3.1-flash-image-preview`:
`1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9`

`gemini-3-pro-image-preview` and `gemini-2.5-flash-image`:
`1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9`

Only 3.1 Flash supports the extreme banner ratios (`1:4`, `1:8`, `4:1`, `8:1`).

## Image Sizes

| Size | Approx pixels | Models |
|---|---|---|
| `"512"` / `"0.5K"` | ~512 long edge | 3.1 Flash only |
| `"1K"` | ~1024 long edge | All |
| `"2K"` | ~2048 long edge | 3 Pro, 3.1 Flash |
| `"4K"` | ~3840 long edge | 3 Pro, 3.1 Flash |

Indicative output token cost for 3.1 Flash (will vary by model and aspect):
- 0.5K: ~747 tokens
- 1K: ~1120 tokens
- 2K: ~1680 tokens
- 4K: ~2520 tokens

## Reference Image Limits

| Model | Object refs | Character refs | Total |
|---|---|---|---|
| `gemini-3.1-flash-image-preview` | up to 10 | up to 4 | up to 14 |
| `gemini-3-pro-image-preview` | up to 6 | up to 5 | up to 11 |
| `gemini-2.5-flash-image` | — | — | up to 3 |

References are sent as additional `parts` entries with `inline_data` (or `file_data` from the Files API). Label each image's role in the prompt text rather than relying on order alone.

## Thinking

- 3 Pro: thinking enabled by default. Use `thinkingLevel: "minimal"` to skip reasoning when the brief is direct.
- 3.1 Flash: thinking opt-in. Use `thinkingLevel: "High"` for layout-heavy prompts (infographics, multi-element scenes).
- 2.5 Flash: no thinking knob.

Interim "thought" images may be generated and are not charged as image outputs, but thinking tokens are billed regardless of `includeThoughts`.

## Grounding With Google Search

```json
"tools": [{ "google_search": {} }]
```

- 3.1 Flash: web search and image search.
- 3 Pro and 2.5 Flash: web search only.
- Image search cannot retrieve images of people.
- Grounding metadata is returned in `candidates[0].groundingMetadata`.

## Multi-Turn Chat

Use the chat session pattern for iterative editing:

```python
chat = client.chats.create(
    model="gemini-3.1-flash-image-preview",
    config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
)

response = chat.send_message("Create an infographic about photosynthesis")
# Refine:
response = chat.send_message("Translate the labels to Spanish and keep the same layout")
```

Each turn keeps prior images and prompts as context, which is stronger than re-sending references in fresh one-shots.

## Batch API

For high-volume generation jobs, the Batch API accepts up to 24-hour turnaround in exchange for higher rate limits. Use it when the request count crosses interactive limits.

## Limitations

- All outputs carry an invisible **SynthID** watermark.
- **No transparent backgrounds**.
- **No audio or video input** for image models.
- 12+ languages are supported optimally for prompts (English, German, Spanish, French, Italian, Portuguese, Japanese, Korean, Chinese, Hindi, Arabic, Russian, etc.). English remains the strongest.
- Image-search grounding cannot retrieve images of people.

## Practical Guidance

- Default to `gemini-3.1-flash-image-preview` for new work. It has the widest aspect ratio set, the most reference slots, and competitive output quality.
- Move to `gemini-3-pro-image-preview` when the task needs layout reasoning, infographics, or premium fidelity.
- Use `gemini-2.5-flash-image` only for cheap drafts and simple subjects at 1K.
- Keep `imageSize` at `1K` while exploring; bump to `2K`/`4K` once the prompt is locked.
- Disable Pro thinking for direct renders to save tokens.
- Add Google Search grounding only when the image must reflect a real subject; treat the result as illustration, not citation.
