---
name: model-prompting
description: >
  Model-family-specific prompt craft for model endpoints. Trigger when the
  user mentions a specific model family by name and asks how to prompt it
  ("how do I prompt Kling", "GPT Image 2 prompt structure", "Happy Horse
  tips"), or when prompts to a routed endpoint keep coming back generic and
  the family's known nuances should be applied. For endpoint selection
  ("which model for X"), use `model-catalog` instead. This skill is
  about how to talk to a model once it has been chosen. Routing: meta (prompt-craft reference); use `model-catalog` instead to choose a model.
---

# Model Prompting

> **Runtime:** All endpoint calls use the `vg generate` CLI (`npm install -g vibedgames`, or `pnpm dogfood` in this repo). The API key lives on the vibedgames server, so there is no per-machine setup. See the `generate` skill for the command reference.

Model families have meaningful prompting nuances. A prompt that works on GPT Image 2 (long, structured, exact text in quotes) will fail on Happy Horse (which wants ~20 plain-English words). This skill collects family-specific guides.

## When to load which reference

| Reference                                   | Load when                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [kling.md](references/kling.md)             | Working with Kling video models (O3, v3), multi-prompt, element controls, Standard vs Pro tier        |
| [gpt-image-2.md](references/gpt-image-2.md) | Working with `openai/gpt-image-2` or `/edit`, structured prompts, EXACT TEXT, multi-image compositing |
| [happy-horse.md](references/happy-horse.md) | Working with `alibaba/happy-horse/text-to-video` or `image-to-video`, brevity-first, camera language  |

## Universal principles (all families)

1. **Visual facts beat prestige adjectives.** Replace "stunning, cinematic, masterpiece" with "overcast daylight, brushed aluminum, 50mm feel."
2. **Style tags need visual targets.** "Minimalist brutalist" → "cream background, heavy black sans serif, asymmetrical type block, generous negative space."
3. **One controlled variable per iteration.** Comparison only works when one axis changes at a time.
4. **Inspect schema before assuming a control exists.** `vg generate schema <endpoint_id> --json`. Negative prompt, seed, multi-prompt, and reference-image fields differ across families.
5. **Per-family rules override universal advice.** Happy Horse rejects what GPT Image 2 rewards.

## Catalog cross-reference

For "which model do I use" questions, see `model-catalog`:

- Text-to-image endpoint selection → [model-catalog/references/text-to-image.md](../model-catalog/references/text-to-image.md)
- Text-to-video endpoint selection → [model-catalog/references/text-to-video.md](../model-catalog/references/text-to-video.md)
- Image-to-video endpoint selection → [model-catalog/references/image-to-video.md](../model-catalog/references/image-to-video.md)
