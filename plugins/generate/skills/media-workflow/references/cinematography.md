# Cinematography Recipe

Use this recipe when the user needs cinematic direction, not generic "make it cinematic" prompting. Write concrete visual direction. Avoid empty prestige words.

## Inputs to collect

Ask only for what affects the shot:

- Subject and action.
- Medium: still image, video, image-to-video, edit, storyboard frame.
- Genre and mood.
- Framing: close-up, medium, wide, overhead, POV, profile, locked-off.
- Camera motion (video only): push-in, dolly, tracking, handheld, crane, drone.
- Lens feel: wide, normal, telephoto, macro, shallow or deep focus.
- Lighting: natural, practical, studio, noir, high key, low key, backlit.
- Output: aspect ratio, duration, first frame, last frame, download path.
- Preferred model, if the user has a specific cinematography model or quality/cost profile in mind.

## Genmedia workflow

1. Start from routed endpoint IDs (see [model-catalog](../../model-catalog/SKILL.md)):

```bash
vg generate models --endpoint_id openai/gpt-image-2 --json
vg generate models --endpoint_id fal-ai/nano-banana-pro --json
vg generate models --endpoint_id bytedance/seedance-2.0/text-to-video --json
vg generate models --endpoint_id bytedance/seedance-2.0/image-to-video --json
vg generate models --endpoint_id xai/grok-imagine-video/text-to-video --json
```

Use text search only when no routed endpoint covers the camera-control role:

```bash
vg generate models "cinematic video generation camera movement" --json
vg generate docs "video generation camera movement prompt" --json
```

2. Inspect schema and use only supported controls.

```bash
vg generate schema <endpoint_id> --json
vg generate pricing <endpoint_id> --json
```

3. Upload references when using image-to-video, first-frame, last-frame, style reference, or character/product continuity.

```bash
vg generate upload ./frame.png --json
```

4. Stills with direct download:

```bash
vg generate run <endpoint_id> \
--prompt "<cinematography prompt>" \
--download "./outputs/cinema/{request_id}_{index}.{ext}" \
--json
```

5. Video async:

```bash
vg generate run <endpoint_id> \
--prompt "<shot prompt>" \
--image_url "<uploaded frame if supported>" \
--async \
--json

vg generate status <endpoint_id> <request_id> \
--download "./outputs/cinema/{request_id}_{index}.{ext}" \
--json
```

## Prompt build order (SCLCAM)

1. **S**ubject, who or what is in frame.
2. **C**ontext, location, time, weather, story moment.
3. **L**ens / framing, distance, angle, focal length feel, depth of field.
4. **C**amera motion, only for video or if motion blur is desired.
5. **A**tmosphere, haze, rain, practicals, reflections, texture.
6. **M**ood / color, palette, contrast, grade, exposure style.
7. Output controls, aspect ratio, duration, first-frame continuity.

Skeleton:

```text
[subject] in [context], framed as [shot size and angle], [lens feel],
[lighting setup], [camera movement if video], [color grade], [texture],
[duration or aspect ratio], [continuity constraints]
```

## Shot language, lighting, lens, and color

These vocabularies live in the `cinematography` skill — use them as the menu when filling the SCLCAM skeleton:

- Shot sizes, angles, camera movement, composition, continuity language: [../../cinematography/references/shot-language.md](../../cinematography/references/shot-language.md)
- Lighting setups, lens feel, depth of field, color grade, texture: [../../cinematography/references/lighting-lens-color.md](../../cinematography/references/lighting-lens-color.md)

## Examples

### Noir close-up

```text
a detective sitting alone in a parked car at night, close-up from passenger
seat angle, 50mm lens feel, rain streaks on the window in foreground, hard
streetlight slashes across his face, low key noir lighting, deep shadows,
muted green and amber grade, still frame, no text
```

### Product macro glide

```text
single continuous macro glide across the brushed steel edge of a luxury watch,
100mm macro lens feel, black velvet surface, thin strip light reflected along
the bevel, shallow depth of field, slow controlled camera movement, clean dark
commercial grade, no extra text, no logo distortion
```

### Sci-fi wide shot

```text
small astronaut crossing a vast white salt flat toward a black monolith,
extreme wide shot, low horizon, 24mm lens feel, late afternoon backlight,
long shadow, minimal composition, cool silver color grade, quiet atmospheric
haze, cinematic still, no extra ships
```

### Handheld pursuit

```text
8 second handheld tracking shot following a woman running through a narrow
market alley at night, camera shoulder-height behind her, practical neon and
food stall lights, motion blur on background, subject remains readable,
urgent thriller pacing, one continuous shot, no cuts
```

### Warm interior drama

```text
two siblings at a kitchen table after midnight, medium-wide static frame,
35mm lens feel, warm practical lamp on table, cool moonlight through window,
subtle haze, quiet tension, naturalistic color grade, deep focus enough to
read both faces, no melodramatic poses
```

## Quality bar

Before returning, check:

- Camera movement is physically plausible for the scene.
- Lens, shot size, and camera angle do not contradict each other.
- Lighting direction is clear and consistent.
- Color grade supports the mood without flattening subject detail.
- Video prompt describes one shot unless the selected model supports multiple prompts or shot lists.
- Downloaded files come from `downloaded_files[]`, not manually curled URLs.

If a result looks generic, improve specificity in camera, blocking, light, and environment before adding more adjectives.
