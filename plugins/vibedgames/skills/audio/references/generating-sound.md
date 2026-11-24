# Generating a sound bank

Every sound below goes through `vg generate`, so it is billed to the vibedgames
account and needs no other key. Check the schema and price before the first
call of a batch: `vg generate schema <id> --json`, `vg generate pricing <id> --json`.

| Need                                 | Endpoint                                       |
| ------------------------------------ | ---------------------------------------------- |
| Sound effect, loopable bed           | `fal-ai/elevenlabs/sound-effects/v2` (default) |
| Longer SFX (to 30 s), seamless loops | `elevenlabs/sound-effects/v3`                  |
| Foley synced to a clip (trailers)    | `mirelo-ai/sfx2.0/video-to-audio`              |
| Character line                       | `elevenlabs/tts/eleven-v4` (default)           |
| A scene between speakers             | `fal-ai/elevenlabs/text-to-dialogue/eleven-v3` |
| A new voice from a description       | `fal-ai/minimax/voice-design`                  |
| Restyle a recorded line              | `fal-ai/elevenlabs/voice-changer`              |
| Music (vocal or instrumental)        | `elevenlabs/music/v2.5` (default)              |
| Split a track into stems             | `fal-ai/demucs`                                |
| Clean a noisy take                   | `fal-ai/elevenlabs/audio-isolation`            |
| Reverb from an impulse response      | `fal-ai/workflow-utilities/impulse-response`   |

## Write the spec before buying

Keep `audio/bank.json` in the game: one row per sound, with the event that
plays it, the family, the prompt, the endpoint, the duration, the number of
takes and the loudness target. Generate from that file, never from ad-hoc
prompts, so any take can be regenerated exactly.

```json
{
  "id": "pistol_fire",
  "family": "weapons",
  "event": "player.fire",
  "endpoint": "fal-ai/elevenlabs/sound-effects/v2",
  "prompt": "single compact pistol shot, sharp transient, short indoor tail, no music",
  "duration_seconds": 1.2,
  "takes": 4,
  "lufs": -14
}
```

## Prompts that work

- **Name the source, the attack and the tail.** "heavy wooden door slam, hard
  attack, short room reverb" beats "door sound".
- **Say what it is not.** "no music, no voice, no ambience" stops extra
  material leaking into a one-shot.
- **One event per file.** A "combo" file with three hits cannot be timed to
  animation. Generate the hit, then sequence it in code.
- **Beds: ask for a loop, then test it.** Use the endpoint's loop option where
  the schema has one, and still play it twice back to back in the game.

## Batch discipline

1. **Prove one row end to end first.** Generate one take, master it, load it
   in the game, trigger it from its event, record the master tap, measure it.
   Only then buy the rest of its family.
2. **Download at once.** `--download ./public/audio/<family>/` on every call.
   Results expire upstream; a timed-out request is recovered with
   `vg generate status <id> <request_id> --download …`, never re-bought.
3. **Master every take.** Trim silence, fade the tail, normalise to the
   family's target after encoding:

   ```bash
   ffmpeg -y -i raw.mp3 -af "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,afade=t=in:d=0.02,areverse,loudnorm=I=-14:TP=-1.5:LRA=7" -c:a libopus -b:a 96k out.ogg
   ```

4. **Screen by measurement, then by a person.** Reject takes that clip, carry
   the wrong event or run long, and say why in the bank file. Never patch a
   bad take; regenerate it. Keep the raw masters.
5. **Voices are cast, not defaulted.** Generate the same two lines with three
   candidate voices and let the person pick by listening. Never clone a voice
   from another game's character or a real person without their consent.
