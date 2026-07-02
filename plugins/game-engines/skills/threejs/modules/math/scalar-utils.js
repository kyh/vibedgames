export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function toFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function lerp(start, end, alpha) {
  return start + (end - start) * alpha;
}

export function fract(value) {
  return value - Math.floor(value);
}

export function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

export function toDeg(radians) {
  return (radians * 180) / Math.PI;
}

export function smoothingAlpha(lag, deltaSeconds) {
  const safeDelta = Math.max(0, deltaSeconds);
  if (lag <= 0) return 1;
  return 1 - Math.exp(-safeDelta / lag);
}

export function smoothToward(current, target, lag, deltaSeconds) {
  return current + (target - current) * smoothingAlpha(lag, deltaSeconds);
}
