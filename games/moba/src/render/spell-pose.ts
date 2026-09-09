export interface SpellCue {
  effect: string;
  at: number;
  facing: 1 | -1;
}
type Gesture = "strike" | "throw" | "brace" | "blink" | "channel";
interface Profile {
  gesture: Gesture;
  duration: number;
}

const profiles = new Map<string, Profile>([
  ["ironvow:Q", { duration: 240, gesture: "strike" }],
  ["ironvow:W", { duration: 340, gesture: "brace" }],
  ["ironvow:R", { duration: 380, gesture: "strike" }],
  ["duskblade:Q", { duration: 220, gesture: "blink" }],
  ["duskblade:W", { duration: 240, gesture: "throw" }],
  ["duskblade:R", { duration: 330, gesture: "strike" }],
  ["stormcaller:Q", { duration: 270, gesture: "throw" }],
  ["stormcaller:W", { duration: 240, gesture: "throw" }],
  ["stormcaller:E", { duration: 280, gesture: "brace" }],
  ["stormcaller:R", { duration: 300, gesture: "channel" }],
  ["emberhex:Q", { duration: 260, gesture: "throw" }],
  ["emberhex:W", { duration: 330, gesture: "brace" }],
  ["emberhex:E", { duration: 300, gesture: "strike" }],
  ["emberhex:R", { duration: 360, gesture: "throw" }],
  ["boomtinker:Q", { duration: 290, gesture: "throw" }],
  ["boomtinker:W", { duration: 280, gesture: "brace" }],
  ["boomtinker:E", { duration: 260, gesture: "blink" }],
  ["boomtinker:R", { duration: 380, gesture: "strike" }],
  ["brewkeeper:Q", { duration: 300, gesture: "brace" }],
  ["brewkeeper:W", { duration: 360, gesture: "brace" }],
  ["brewkeeper:E", { duration: 360, gesture: "brace" }],
  ["brewkeeper:R", { duration: 300, gesture: "channel" }],
]);

/** Instant spells begin at their release, never invent a wind-up before damage.
 * Channels hold a brace only while the accepted simulation still owns one. */
export const spellPose = (
  cue: SpellCue | null,
  channel: { effect: string; until: number } | null,
  now: number,
  facing: 1 | -1,
) => {
  if (!Number.isFinite(now)) {
    return null;
  }
  if (channel && channel.until > now) {
    const profile = profiles.get(channel.effect);
    if (profile?.gesture === "channel") {
      const breath = Math.sin(now * 0.007) * 0.35;
      return {
        angle: -facing * 4,
        frame: null,
        scaleX: 1.025,
        scaleY: 0.965,
        x: -facing * 2,
        y: 1 + breath,
      };
    }
  }
  if (!cue || !Number.isFinite(cue.at) || now < cue.at) {
    return null;
  }
  const profile = profiles.get(cue.effect);
  if (!profile || profile.gesture === "channel") {
    return null;
  }
  const t = (now - cue.at) / profile.duration;
  if (t >= 1) {
    return null;
  }
  const settle = (1 - t) ** 2;
  const f = cue.facing;
  switch (profile.gesture) {
    case "strike": {
      return {
        angle: f * 11 * settle,
        frame: t,
        scaleX: 1 + 0.04 * settle,
        scaleY: 1 - 0.04 * settle,
        x: f * 7 * settle,
        y: 2 * settle,
      };
    }
    case "throw": {
      return {
        angle: f * 7 * settle,
        frame: t,
        scaleX: 1,
        scaleY: 1 + 0.025 * settle,
        x: f * 4 * settle,
        y: -2 * settle,
      };
    }
    case "brace": {
      return {
        angle: -f * 4 * settle,
        frame: null,
        scaleX: 1 + 0.04 * settle,
        scaleY: 1 - 0.05 * settle,
        x: -f * 2 * settle,
        y: 2 * settle,
      };
    }
    case "blink": {
      return {
        angle: -f * 8 * settle,
        frame: null,
        scaleX: 1 - 0.035 * settle,
        scaleY: 1 + 0.035 * settle,
        x: f * 3 * settle,
        y: -3 * settle,
      };
    }
    default: {
      return null;
    }
  }
};
