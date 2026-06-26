# Character Design Recipe

Use this recipe when the user wants to create, refine, or preserve a character. The main objective is **consistency**: keep the character anchor stable and change only the requested scene, expression, outfit, camera, or action.

## Inputs to collect

Only ask for missing inputs that affect identity or model routing.

- Character type: realistic human, stylized, anime, mascot, fantasy, sci-fi.
- Identity anchor: age range, face shape, hair, eyes, build, posture, marks.
- Style: photographic, 3D, illustration, manga, comic, game concept art.
- Needed outputs: portrait, full body, turnaround, expression sheet, outfit set, action still, video shot, edit of an existing character.
- References: source image, approved design, costume, pose, style board.
- Consistency level: exploratory, pitch-ready, production continuity.

## Genmedia workflow

1. Routed endpoints (see [model-catalog/text-to-image](../../model-catalog/references/text-to-image.md) and [image-to-image](../../model-catalog/references/image-to-image.md)):

```bash
vg generate models --endpoint_id openai/gpt-image-2 --json
vg generate models --endpoint_id fal-ai/nano-banana-pro/edit --json
vg generate models --endpoint_id bytedance/seedance-2.0/image-to-video --json
vg generate models --endpoint_id veed/fabric-1.0 --json
```

Fallback discovery:

```bash
vg generate docs "consistent character generation" --json
vg generate models "image editing character consistency" --json
```

2. Inspect schema before each run.

```bash
vg generate schema <endpoint_id> --json
vg generate pricing <endpoint_id> --json
```

3. Upload references.

```bash
vg generate upload ./character-reference.png --json
vg generate upload ./costume-reference.png --json
```

4. Run stills or sheets:

```bash
vg generate run <endpoint_id> \
--prompt "<anchor + variable prompt>" \
--image_url "<reference url if supported>" \
--download "./outputs/characters/{request_id}_{index}.{ext}" \
--json
```

5. Run video async:

```bash
vg generate run <endpoint_id> \
--prompt "<anchor + shot action>" \
--image_url "<approved character frame if supported>" \
--async \
--json

vg generate status <endpoint_id> <request_id> \
--download "./outputs/characters/{request_id}_{index}.{ext}" \
--json
```

Use only schema-supported fields. If the model exposes seed, reference image, image strength, multiple image inputs, or negative prompt, use them deliberately and record what was used.

## Anchor system and prompt patterns

The anchor is the **identity contract**: keep it compact and repeat it in every prompt that should preserve the same character. The full anchor field list, immutable anchor + variable templates, what-can-change / what-should-not-drift lists, and consistency escalation live in the `character-design` skill:

- Anchor system: [../../character-design/references/anchor-system.md](../../character-design/references/anchor-system.md)
- Prompt-pattern templates (first concept, full-body, turnaround, expression sheet, outfit variation, character video shot, negative prompt): [../../character-design/references/prompt-patterns.md](../../character-design/references/prompt-patterns.md)

If a result changes identity, **strengthen the anchor or switch to a reference/edit workflow** instead of adding more style words.

## Examples

### Realistic editorial character

```text
CHARACTER ANCHOR:
Maren, woman in her early 30s, oval face with high cheekbones, almond green
eyes, straight nose, soft defined lips, light olive skin with a small mole
under the left eye, dark auburn shoulder-length wavy hair with a center part,
slim athletic build, upright calm posture, charcoal wool coat and small silver
ear cuff, realistic cinematic photography

SHOT VARIABLE:
waist-up portrait in a quiet train station at blue hour, thoughtful expression,
three-quarter angle, soft practical lights behind her, shallow depth of field,
35mm documentary lens feel, no extra people in focus
```

### Stylized sci-fi pilot

```text
CHARACTER ANCHOR:
Kade, young adult male sci-fi pilot, square face, heavy brows, narrow dark
brown eyes, short black textured hair, warm brown skin, compact muscular
build, matte white flight jacket with orange collar stripe, small triangular
mission patch on left chest, high-end animated feature style

SHOT VARIABLE:
full-body design sheet, front view, helmet tucked under one arm, neutral gray
background, clean readable silhouette, precise costume seams, no extra logos
```

### Mascot concept

```text
CHARACTER ANCHOR:
round friendly tea-shop mascot, small fox-like creature with cream fur, amber
ears, oversized green scarf, tiny ceramic cup pendant, soft plush proportions,
warm illustrated brand mascot style

SHOT VARIABLE:
three-quarter standing pose, waving with one paw, simple mint background,
clear silhouette, cheerful but not childish, no text, no extra mascots
```

### Outfit-only edit

```text
keep the uploaded character's face, hairstyle, skin tone, body proportions,
and illustration style exactly the same; change only the outfit to a navy
raincoat over a cream sweater, wet street lighting, same identity, no face
changes, no age changes, no additional characters
```

## Quality bar

Reject or retry when:

- Face shape, eye spacing, hairstyle, marks, or body build drift.
- Outfit changes when the prompt says only expression or pose should change.
- The sheet mixes styles across panels.
- Hands or props distract from the requested design task.
- Video motion changes age, face, costume, or silhouette.

Return downloaded paths and include the anchor used so future prompts can reuse the same identity.
