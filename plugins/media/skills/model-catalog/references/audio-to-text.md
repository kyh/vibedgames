# Audio-to-Text Endpoints

Curated picks for STT (speech-to-text) and audio cleanup. Verify with `vg media models --endpoint_id <id> --json` before running.

## STT · General transcription

General-purpose speech → text.

- `wizper`: Whisper v3
- `speech-to-text`: Speech-to-Text
- `speech-to-text/turbo`: STT Turbo
- `speech-to-text/stream`: STT Stream
- `speech-to-text/turbo/stream`: STT Turbo Stream
- `elevenlabs/speech-to-text`: ElevenLabs · STT

## STT · Diarization (speaker labels)

Transcription with speaker separation.

- `elevenlabs/speech-to-text/scribe-v2`: ElevenLabs · Scribe v2

## Audio cleanup / separation

Audio cleanup, isolation, separation.

- `demucs`: Demucs (vocal/instrumental separation)
- `elevenlabs/audio-isolation`: ElevenLabs · Audio Isolation
- `sam-audio/separate`: Sam Audio · Separate
- `sam-audio/span-separate`: Sam Audio · Span Separate

## Common parameters

Inspect schema before running:

```bash
vg media schema wizper --json
vg media schema elevenlabs/speech-to-text/scribe-v2 --json
```

Frequently exposed:

- `audio_url`: URL of audio file
- `language`: explicit language hint (auto-detected if omitted)
- `task`: `transcribe` (default) or `translate` (Whisper translates to English)
- `chunk_level`: segment / word / sentence (when supported)
- `diarize`: boolean (Scribe v2)

## Discovery

```bash
vg media models --category speech-to-text --json
vg media models "audio isolation" --json
vg media docs "speech to text" --json
```

## See also

- For TTS (the inverse), see [text-to-audio.md](text-to-audio.md)
- For video subtitle workflow, see [media-recipes/references/video-with-audio.md](../../media-recipes/references/video-with-audio.md)
