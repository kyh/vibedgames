// Continuous motor + rolling air. Fixed seeds and harmonic phases avoid beats,
// clicks and random revs. Speed/load modulation belongs to Sfx.setEngine().
// node tools/generate-driving-audio.mjs /tmp/driving-originals
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const destination = process.argv.at(2);
if (!destination) {
  throw new Error("Usage: node tools/generate-driving-audio.mjs <wav-directory>");
}
mkdirSync(destination, { recursive: true });
const sampleRate = 44_100;
const seconds = 8;
const frameCount = sampleRate * seconds;
const tau = Math.PI * 2;

const air = (seed) => {
  let state = seed;
  let bass = 0;
  let body = 0;
  let low = 0;
  const highCoefficient = 1 - Math.exp((-tau * 1500) / sampleRate);
  const lowCoefficient = 1 - Math.exp((-tau * 160) / sampleRate);
  return () => {
    // oxlint-disable-next-line no-bitwise -- LCG needs the uint32 wrap
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = (state / 4_294_967_296) * 2 - 1;
    low += (noise - low) * highCoefficient;
    body += (low - body) * highCoefficient;
    bass += (body - bass) * lowCoefficient;
    return body - bass;
  };
};

for (const name of ["engine-loop", "road-loop"]) {
  const pcm = Buffer.alloc(frameCount * 8);
  const leftAir = air(4107);
  const rightAir = air(9821);
  // Warm filter memory before recording so frame zero has the same steady bed.
  for (let i = 0; i < sampleRate; i += 1) {
    leftAir();
    rightAir();
  }
  for (let i = 0; i < frameCount; i += 1) {
    const phase = (i / sampleRate) * tau * 140;
    // Phase-locked harmonics: no detuned oscillators or low-frequency beating.
    const motor =
      Math.sin(phase) * 0.14 + Math.sin(phase * 2) * 0.028 + Math.sin(phase * 3) * 0.005;
    const left = leftAir();
    const right = rightAir();
    pcm.writeFloatLE(name === "engine-loop" ? motor + left * 0.025 : left, i * 8);
    pcm.writeFloatLE(name === "engine-loop" ? motor + right * 0.025 : right, i * 8 + 4);
  }
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "f32le",
      "-ac",
      "2",
      "-ar",
      String(sampleRate),
      "-i",
      "pipe:0",
      "-c:a",
      "pcm_f32le",
      path.join(destination, `${name}.wav`),
    ],
    { input: pcm },
  );
  console.log(`${name}: ${seconds}s continuous WAV`);
}
