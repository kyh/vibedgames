# Audio QA when you cannot listen

You cannot hear the game, but you can record exactly what it sends to the
speakers, line that recording up with what the game did, and test written
relationships between sounds. That catches most mix faults before a person
listens. It never replaces the person: every report still opens with "nobody
has listened to this build yet" until someone has.

## 1. Tap the master, not the files

Judge the output after every bus, duck and limiter, never the source files.
Add a tap behind a test flag that changes nothing else:

```js
// public/master-tap.js — loaded only when ?audiotap=1
class MasterTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.n = 0;
    this.t0 = null;
  }
  process([input]) {
    const block = input?.length
      ? input.map((c) => c.slice())
      : [new Float32Array(128), new Float32Array(128)];
    this.t0 ??= currentTime;
    this.chunks.push(block);
    this.n += 128;
    if (this.n >= sampleRate / 4) {
      this.port.postMessage({ t0: this.t0, chunks: this.chunks });
      this.chunks = [];
      this.n = 0;
      this.t0 = null;
    }
    return true;
  }
}
registerProcessor("master-tap", MasterTap);
```

```js
// in the audio engine, only when the flag is on
await ctx.audioWorklet.addModule("/master-tap.js");
const tap = new AudioWorkletNode(ctx, "master-tap", {
  channelCount: 2,
  channelCountMode: "explicit",
});
limiter
  .connect(tap)
  .connect(new GainNode(ctx, { gain: 0 }))
  .connect(ctx.destination);
window.__AUDIO_TAP__ = { batches: [], events: [] };
tap.port.onmessage = (e) => window.__AUDIO_TAP__.batches.push(e.data);

// call with the same `when` passed to source.start(when)
export const logSound = (kind, when) => window.__AUDIO_TAP__?.events.push({ kind, t: when });
```

Silent quanta are recorded as zeros, so batches stay continuous and every
logged event lines up with the samples on the audio clock.

## 2. Capture the player's path

- The **built** game (`vite build && vite preview`), not the dev server.
- Real input through the browser (`vg playtest press Enter` for menus, a
  dispatched `KeyboardEvent` for held game keys, as `playtest` →
  `references/cli-cheatsheet.md` shows), never a direct call into the game.
- Run it twice: default autoplay, and strict
  (`--autoplay-policy=user-gesture-required`). Many launchers allow autoplay
  by default, which hides exactly the "silent until you click twice" bug.
- Pull the recording out with `vg playtest eval`, base64-encode the Float32
  data in the page, and write a 32-bit float WAV in Node.

## 3. Measure with ffmpeg

```bash
# integrated loudness, loudness range, true peak
ffmpeg -hide_banner -i run.wav -af ebur128=peak=true -f null - 2>&1 | tail -12

# loudness of one moment (seconds 12.0–12.4)
ffmpeg -hide_banner -ss 12 -t 0.4 -i run.wav -af ebur128 -f null - 2>&1 | grep "I:"

# a band a laptop speaker can actually play (200 Hz – 6 kHz)
ffmpeg -hide_banner -i run.wav -af "highpass=f=200,lowpass=f=6000,ebur128" -f null - 2>&1 | grep "I:"

# spectrogram to look at (clicks = vertical lines, whines = horizontal lines)
ffmpeg -y -i run.wav -lavfi showspectrumpic=s=1600x600:legend=1 spec.png
```

Read the spectrogram as an image: vertical lines are clicks, horizontal lines
are whines or fixed tones, a tail cut square is a sound stopped early.

## 4. Gate relationships, not absolutes

Absolute levels drift with every change. What a player hears is how sounds sit
against each other. Write a table for the game and check it after every sound
change. A starting point for an action game:

| Relationship                                  | Bar          |
| --------------------------------------------- | ------------ |
| Player's action over the loudest rival sound  | ≥ 4 LU       |
| Player's action over any loop or bed          | ≥ 6 dB       |
| Footsteps over ambience (laptop band)         | ≥ 6 dB       |
| A busy fight, integrated                      | −16 LUFS ± 2 |
| A quiet stretch, integrated                   | −26 LUFS ± 3 |
| Output true peak                              | ≤ −1 dBTP    |
| Gaps in a rapid-fire burst (dropped triggers) | 0            |
| Non-finite samples                            | 0            |

Prove each check fails on a planted fault (bypass the limiter, mute a bus)
before trusting its pass.

## 5. Spoken lines

Run each voiced line through the game's final chain into a speech recogniser
(`vg generate run fal-ai/wizper` or another endpoint from `model-catalog` →
`references/audio-to-text.md`) and compare the transcript with the script.
Invented names fool recognisers; flag any line whose transcript differs.

## 6. Then a person listens

Ask the person to play two minutes with sound on, and give them three specific
questions (is your own action the loudest thing? does anything hurt? does
anything repeat?). Record their answers word for word.
