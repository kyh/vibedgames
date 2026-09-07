export type SpellCue = { effect: string; at: number; facing: 1 | -1 };
type Gesture = "strike" | "throw" | "brace" | "blink" | "channel";
type Profile = { gesture: Gesture; duration: number };

const profiles = new Map<string, Profile>([
  ["ironvow:Q", { gesture: "strike", duration: 240 }],
  ["ironvow:W", { gesture: "brace", duration: 340 }],
  ["ironvow:R", { gesture: "strike", duration: 380 }],
  ["duskblade:Q", { gesture: "blink", duration: 220 }],
  ["duskblade:W", { gesture: "throw", duration: 240 }],
  ["duskblade:R", { gesture: "strike", duration: 330 }],
  ["stormcaller:Q", { gesture: "throw", duration: 270 }],
  ["stormcaller:W", { gesture: "throw", duration: 240 }],
  ["stormcaller:E", { gesture: "brace", duration: 280 }],
  ["stormcaller:R", { gesture: "channel", duration: 300 }],
  ["emberhex:Q", { gesture: "throw", duration: 260 }],
  ["emberhex:W", { gesture: "brace", duration: 330 }],
  ["emberhex:E", { gesture: "strike", duration: 300 }],
  ["emberhex:R", { gesture: "throw", duration: 360 }],
  ["boomtinker:Q", { gesture: "throw", duration: 290 }],
  ["boomtinker:W", { gesture: "brace", duration: 280 }],
  ["boomtinker:E", { gesture: "blink", duration: 260 }],
  ["boomtinker:R", { gesture: "strike", duration: 380 }],
  ["brewkeeper:Q", { gesture: "brace", duration: 300 }],
  ["brewkeeper:W", { gesture: "brace", duration: 360 }],
  ["brewkeeper:E", { gesture: "brace", duration: 360 }],
  ["brewkeeper:R", { gesture: "channel", duration: 300 }],
]);

/** Instant spells begin at their release, never invent a wind-up before damage.
 * Channels hold a brace only while the accepted simulation still owns one. */
export function spellPose(
  cue: SpellCue | null,
  channel: { effect: string; until: number } | null,
  now: number,
  facing: 1 | -1,
) {
  if (!Number.isFinite(now)) return null;
  if (channel && channel.until > now) {
    const profile = profiles.get(channel.effect);
    if (profile?.gesture === "channel") {
      const breath = Math.sin(now * 0.007) * 0.35;
      return {
        x: -facing * 2,
        y: 1 + breath,
        angle: -facing * 4,
        scaleX: 1.025,
        scaleY: 0.965,
        frame: null,
      };
    }
  }
  if (!cue || !Number.isFinite(cue.at) || now < cue.at) return null;
  const profile = profiles.get(cue.effect);
  if (!profile || profile.gesture === "channel") return null;
  const t = (now - cue.at) / profile.duration;
  if (t >= 1) return null;
  const settle = (1 - t) ** 2;
  const f = cue.facing;
  switch (profile.gesture) {
    case "strike":
      return {
        x: f * 7 * settle,
        y: 2 * settle,
        angle: f * 11 * settle,
        scaleX: 1 + 0.04 * settle,
        scaleY: 1 - 0.04 * settle,
        frame: t,
      };
    case "throw":
      return {
        x: f * 4 * settle,
        y: -2 * settle,
        angle: f * 7 * settle,
        scaleX: 1,
        scaleY: 1 + 0.025 * settle,
        frame: t,
      };
    case "brace":
      return {
        x: -f * 2 * settle,
        y: 2 * settle,
        angle: -f * 4 * settle,
        scaleX: 1 + 0.04 * settle,
        scaleY: 1 - 0.05 * settle,
        frame: null,
      };
    case "blink":
      return {
        x: f * 3 * settle,
        y: -3 * settle,
        angle: -f * 8 * settle,
        scaleX: 1 - 0.035 * settle,
        scaleY: 1 + 0.035 * settle,
        frame: null,
      };
  }
}
