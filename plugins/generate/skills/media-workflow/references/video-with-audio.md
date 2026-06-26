# Video With Audio Recipe

Use this recipe to add narration, sound effects, music, or environmental ambience to a silent video. Two flows depending on whether the audio already exists or should be AI-generated.

## Inputs to collect

- **Source video**: URL or local path.
- **Audio source**: one of:
- existing audio file (URL or local), straight merge
- text prompt for AI-generated SFX / ambience (e.g., "city street with distant traffic")
- text for narration (TTS first, then merge)
- reference music style for AI music generation
- **Sync mode**: does the audio drive the cut, or just sit under existing video?

## Flow A: generated SFX / ambience (single endpoint)

`fal-ai/mmaudio-v2` generates synchronized audio that matches video content from a prompt.

```bash
URL_VIDEO=$(vg generate upload ./silent.mp4 --json | jq -r '.url')

vg generate run fal-ai/mmaudio-v2 \
 --video_url "$URL_VIDEO" \
 --prompt "City street ambiance with car horns and people talking" \
 --download "./outputs/with-audio/{request_id}_{index}.{ext}" \
 --async \
 --json
```

`fal-ai/mmaudio-v2` is good for ambient/foley generation. The output is a video with the new audio merged in.

## Flow B: merge existing audio file

When the audio already exists (recorded VO, music track, separate SFX file), use the merge utility:

```bash
URL_VIDEO=$(vg generate upload ./silent.mp4 --json | jq -r '.url')
URL_AUDIO=$(vg generate upload ./voiceover.wav --json | jq -r '.url')

vg generate run fal-ai/ffmpeg-api/merge-audio-video \
 --video_url "$URL_VIDEO" \
 --audio_url "$URL_AUDIO" \
 --download "./outputs/with-audio/{request_id}_{index}.{ext}" \
 --json
```

For the full utility endpoint catalog (split, mix, extract, etc.), search the catalog with `vg generate models --category <modality>`.

## Flow C: TTS narration + merge (chained)

Three steps: generate speech → merge with video → optionally add subtitles.

```bash
URL_VIDEO=$(vg generate upload ./silent.mp4 --json | jq -r '.url')

# Step 1: TTS
TTS_RESULT=$(vg generate run fal-ai/minimax/speech-2.6-turbo \
 --text "Welcome to our product demonstration." \
 --json)
URL_AUDIO=$(echo "$TTS_RESULT" | jq -r '.audio.url')

# Step 2: merge audio + video
MERGE_RESULT=$(vg generate run fal-ai/ffmpeg-api/merge-audio-video \
 --video_url "$URL_VIDEO" \
 --audio_url "$URL_AUDIO" \
 --json)
URL_MERGED=$(echo "$MERGE_RESULT" | jq -r '.video.url')

# Step 3 (optional): auto-subtitles
vg generate run fal-ai/workflow-utilities/auto-subtitle \
 --video_url "$URL_MERGED" \
 --download "./outputs/with-audio/{request_id}_{index}.{ext}" \
 --json
```

For TTS endpoint selection, see [model-catalog/text-to-audio.md](../../model-catalog/references/text-to-audio.md).

## Flow D: music generation + merge

```bash
URL_VIDEO=$(vg generate upload ./silent.mp4 --json | jq -r '.url')

# Step 1: generate music (discover endpoint first)
vg generate models "music generation" --json

# Step 2: merge generated music with video
vg generate run fal-ai/ffmpeg-api/merge-audio-video \
 --video_url "$URL_VIDEO" \
 --audio_url "$URL_MUSIC" \
 --download "./outputs/with-audio/{request_id}_{index}.{ext}" \
 --json
```

For music endpoint selection, search the catalog:

```bash
vg generate models "music generation" --json
vg generate models --category text-to-audio --json | jq '.models[] | select(.tags[]? == "music")'
```

## Endpoint reference

| Endpoint                                           | Mode                                  | Use when                                           |
| -------------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `fal-ai/mmaudio-v2`                                | video + prompt → video with AI audio  | Ambient/foley to match video content from a prompt |
| `fal-ai/ffmpeg-api/merge-audio-video`              | video + audio → merged video          | Existing audio file, deterministic merge           |
| `fal-ai/workflow-utilities/auto-subtitle`          | video → video with karaoke-style subs | Add subtitles after audio is in place              |
| `fal-ai/workflow-utilities/add-subtitles-to-video` | video + subtitle file → subbed video  | Provided subtitle text, no transcription           |

## Quality bar

Before returning:

- Audio sync matches visual cuts (especially for foley generated from prompt).
- Speech is intelligible; SFX volume does not drown narration.
- Output runtime equals source video runtime (no truncation).
- For TTS: voice tone matches content (don't pair upbeat marketing narration with somber video).
- Output paths come from `downloaded_files[]`.

## Tips

- **AI audio (mmaudio) is non-deterministic.** Run 2-3 generations if the first is mistimed and pick the best.
- **For dialog**, record real audio rather than relying on TTS unless the project explicitly wants synthetic voice.
- **Loudness:** AI-generated SFX is often loud. Use `vg generate models "audio normalize" --json` if mixing layers.
- **Subtitles** add accessibility, auto-subtitle tends to get character names wrong; review before publishing.

## Common parameters

```bash
vg generate schema fal-ai/mmaudio-v2 --json
vg generate schema fal-ai/ffmpeg-api/merge-audio-video --json
vg generate schema fal-ai/workflow-utilities/auto-subtitle --json
```

For multi-track audio (BG music + narration + SFX), do multi-step merges or use `fal-ai/workflow-utilities/amix-audio` to combine audio first, then merge with video.
