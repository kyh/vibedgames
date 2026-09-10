// Normalize original audio and join loop seams. No extra dependencies.
// node tools/prepare-sfx.mjs /path/to/originals [clip-name...]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raw = process.argv.at(2);
if (!raw) {
  throw new Error("Usage: node tools/prepare-sfx.mjs <original-directory> [clip-name...]");
}
const directory = fileURLToPath(new URL("../public/audio/cozy/", import.meta.url));
const manifestPath = path.join(directory, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const selected = new Set(process.argv.slice(3));
const unknown = [...selected].filter(
  (name) => !manifest.sounds.some((sound) => sound.name === name),
);
if (unknown.length > 0) {
  throw new Error(`Unknown clip(s): ${unknown.join(", ")}`);
}
const sampleRate = 44_100;
const channels = 2;
const report = [];
for (const sound of manifest.sounds) {
  if (selected.size > 0 && !selected.has(sound.name)) {
    continue;
  }
  const pcm = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path.join(raw, `${sound.name}.${sound.source?.format ?? "mp3"}`),
      "-f",
      "f32le",
      "-ac",
      String(channels),
      "-ar",
      String(sampleRate),
      "pipe:1",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  let frames = Array.from({ length: pcm.length / 8 }, (_, frame) => [
    pcm.readFloatLE(frame * 8),
    pcm.readFloatLE(frame * 8 + 4),
  ]);
  if (sound.loop) {
    const overlap = Math.round(sampleRate * (sound.source?.crossfade_seconds ?? 0.08));
    const join = frames.slice(-overlap).map((frame, i) => {
      const t = i / (overlap - 1);
      const outgoing =
        sound.source?.crossfade === "equal-power" ? Math.cos((t * Math.PI) / 2) : 1 - t;
      const incoming = sound.source?.crossfade === "equal-power" ? Math.sin((t * Math.PI) / 2) : t;
      return frame.map((sample, channel) => sample * outgoing + frames[i][channel] * incoming);
    });
    frames = [...frames.slice(overlap, -overlap), ...join];
  } else {
    // Trim only leading/trailing silence. Preserve internal rhythm and decay.
    const threshold = 0.003;
    const first = frames.findIndex((frame) => frame.some((sample) => Math.abs(sample) > threshold));
    const last = frames.findLastIndex((frame) =>
      frame.some((sample) => Math.abs(sample) > threshold),
    );
    if (first === -1 || last < first) {
      throw new Error(`Silent generation: ${sound.name}`);
    }
    frames = frames.slice(Math.max(0, first - 220), Math.min(frames.length, last + 1323));
    const attack = 220;
    const release = 882;
    frames = frames.map((frame, i) =>
      frame.map((sample) => sample * Math.min(1, i / attack, (frames.length - 1 - i) / release)),
    );
  }
  let peak = 0;
  let sum = 0;
  for (const frame of frames) {
    for (const value of frame) {
      peak = Math.max(peak, Math.abs(value));
      sum += value * value;
    }
  }
  const rms = Math.sqrt(sum / (frames.length * channels));
  if (rms < 0.0001) {
    throw new Error(`Empty audio: ${sound.name}`);
  }
  // Keep dynamics. A peak ceiling wins over the RMS target; never compress a transient flat.
  const gain = Math.min((sound.loop ? 0.105 : 0.15) / rms, 0.75 / peak);
  const output = Buffer.alloc(frames.length * 8);
  for (const [i, frame] of frames.entries()) {
    for (const [channel, value] of frame.entries()) {
      output.writeFloatLE(value * gain, i * 8 + channel * 4);
    }
  }
  const destination = path.join(directory, `${sound.name}.ogg`);
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "f32le",
      "-ac",
      String(channels),
      "-ar",
      String(sampleRate),
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "96k",
      destination,
    ],
    { input: output },
  );
  // Verify the delivered codec, including any lossy-encoding overshoot.
  const decoded = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", destination, "-f", "f32le", "pipe:1"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  let finalPeak = 0;
  let finalSum = 0;
  for (let i = 0; i < decoded.length; i += 4) {
    const value = decoded.readFloatLE(i);
    if (!Number.isFinite(value)) {
      throw new TypeError(`Invalid PCM: ${sound.name}`);
    }
    finalPeak = Math.max(finalPeak, Math.abs(value));
    finalSum += value * value;
  }
  if (finalPeak > 0.9) {
    throw new Error(`Insufficient headroom: ${sound.name}`);
  }
  const analysis = {
    peakDb: Number((20 * Math.log10(finalPeak)).toFixed(2)),
    rmsDb: Number((20 * Math.log10(Math.sqrt(finalSum / (decoded.length / 4)))).toFixed(2)),
    seconds: Number((frames.length / sampleRate).toFixed(3)),
  };
  sound.processed = analysis;
  report.push({ name: sound.name, ...analysis });
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
