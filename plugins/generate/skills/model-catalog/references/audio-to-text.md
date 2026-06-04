# Audio-to-Text Endpoints

Curated picks for STT (speech-to-text) and audio cleanup. Verify with `vg generate models --endpoint_id <id> --json` before running.

## STT · General transcription

General-purpose speech → text.

- `fal-ai/wizper`: Whisper v3
- `fal-ai/speech-to-text`: Speech-to-Text
- `fal-ai/speech-to-text/turbo`: STT Turbo
- `fal-ai/speech-to-text/stream`: STT Stream
- `fal-ai/speech-to-text/turbo/stream`: STT Turbo Stream
- `fal-ai/elevenlabs/speech-to-text`: ElevenLabs · STT

## STT · Diarization (speaker labels)

Transcription with speaker separation.

- `fal-ai/elevenlabs/speech-to-text/scribe-v2`: ElevenLabs · Scribe v2

## Audio cleanup / separation

Audio cleanup, isolation, separation.

- `fal-ai/demucs`: Demucs (vocal/instrumental separation)
- `fal-ai/elevenlabs/audio-isolation`: ElevenLabs · Audio Isolation
- `fal-ai/sam-audio/separate`: Sam Audio · Separate
- `fal-ai/sam-audio/span-separate`: Sam Audio · Span Separate

## Common parameters

Inspect schema before running:

```bash
vg generate schema fal-ai/wizper --json
vg generate schema fal-ai/elevenlabs/speech-to-text/scribe-v2 --json
```

Frequently exposed:

- `audio_url`: URL of audio file
- `language`: explicit language hint (auto-detected if omitted)
- `task`: `transcribe` (default) or `translate` (Whisper translates to English)
- `chunk_level`: segment / word / sentence (when supported)
- `diarize`: boolean (Scribe v2)

## Discovery

```bash
vg generate models --category speech-to-text --json
vg generate models "audio isolation" --json
vg generate docs "speech to text" --json
```

## See also

- For TTS (the inverse), see [text-to-audio.md](text-to-audio.md)
- For video subtitle workflow, see [media-recipes/references/video-with-audio.md](../../media-recipes/references/video-with-audio.md)
