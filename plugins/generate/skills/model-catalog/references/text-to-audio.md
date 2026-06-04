# Text-to-Audio Endpoints

Curated picks across 6 use cases. TTS Premium / Fast / Multilingual / Voice clone, Music Vocal+lyrics, Music Instrumental+SFX. Verify with `vg generate models --endpoint_id <id> --json` before running.

## TTS · Premium expressive

High-quality, expressive TTS.

- `elevenlabs/tts/eleven-v3`: ElevenLabs · Eleven v3
- `elevenlabs/text-to-dialogue/eleven-v3`: ElevenLabs · Text-to-Dialogue (multi-speaker scene)
- `minimax/speech-2.8-hd`: Minimax · Speech 2.8 HD

## TTS · Fast / cheap

Low-latency, economical TTS.

- `minimax/speech-2.8-turbo`: Minimax · 2.8 Turbo
- `minimax/speech-2.6-turbo`: Minimax · 2.6 Turbo
- `minimax/speech-02-turbo`: Minimax · 02 Turbo
- `minimax/preview/speech-2.5-turbo`: Minimax · 2.5 Turbo Preview
- `kokoro/american-english`: Kokoro (American English)
- `kokoro/british-english`: Kokoro (British English)

## TTS · Multilingual

Multi-language TTS.

- `elevenlabs/tts/multilingual-v2`: ElevenLabs · Multilingual v2
- `chatterbox/text-to-speech/multilingual`: Resemble · Chatterbox Multilingual
- `qwen-3-tts/text-to-speech/0.6b`: Alibaba · Qwen 3 TTS 0.6B
- `qwen-3-tts/text-to-speech/1.7b`: Alibaba · Qwen 3 TTS 1.7B
- `kokoro/brazilian-portuguese`: Kokoro PT-BR
- `kokoro/french`: Kokoro FR
- `kokoro/hindi`: Kokoro HI
- `kokoro/italian`: Kokoro IT
- `kokoro/japanese`: Kokoro JA
- `kokoro/mandarin-chinese`: Kokoro ZH
- `kokoro/spanish`: Kokoro ES

## TTS · Voice clone / design

Voice cloning and custom voice design.

- `minimax/voice-clone`: Minimax · Voice Cloning
- `minimax/voice-design`: Minimax · Voice Design
- `qwen-3-tts/clone-voice/0.6b`: Alibaba · Qwen 3 Clone (0.6B)
- `qwen-3-tts/clone-voice/1.7b`: Alibaba · Qwen 3 Clone (1.7B)
- `qwen-3-tts/voice-design/1.7b`: Alibaba · Qwen 3 Voice Design

## Music · Vocal + lyrics

Vocal music generation with lyrics.

- `elevenlabs/music`: ElevenLabs · Music
- `minimax-music/v2.6`: Minimax · Music 2.6
- `lyria2`: Lyria 2

## Music · Instrumental / SFX

Instrumental music and sound effects.

- `elevenlabs/sound-effects/v2`: ElevenLabs · Sound Effects v2
- `cassetteai/music-generator`: Cassette AI · Music Generator
- `stable-audio-25/text-to-audio`: Stability AI · Stable Audio 2.5

## Discovery

```bash
vg generate models --category text-to-speech --limit 10 --json
vg generate models --category text-to-audio --limit 10 --json
vg generate models "music generation" --json
vg generate models "sound effect" --json
```

## See also

- For TTS chained into talking-head video: [media-recipes/references/character-lipsync.md](../../media-recipes/references/character-lipsync.md)
- For TTS chained into video narration: [media-recipes/references/video-with-audio.md](../../media-recipes/references/video-with-audio.md)
- For STT (audio → text), see [audio-to-text.md](audio-to-text.md)
