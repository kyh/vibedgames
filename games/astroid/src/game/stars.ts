import { WORLD_WIDTH, WORLD_HEIGHT } from "./constants";

const STAR_COLORS = [
  "#FFFFFF",
  "#FFFFAA",
  "#AAAAFF",
  "#FFAAAA",
  "#AAFFAA",
  "#FFAAFF",
  "#AAFFFF",
] as const;

const STAR_DENSITY = 0.00004;
const TWINKLE_PROBABILITY = 0.7;
const MIN_TWINKLE_SPEED = 2;
const MAX_TWINKLE_SPEED = 4;
const PIXEL_SIZE = 5;
const REGEN_INTERVAL_TICKS = 300; // ~5s at 60fps
const REGEN_PERCENT = 0.15;

const SHOOTING_STAR_PIXEL_SIZE = 2;
const SHOOTING_STAR_SPAWN_TICKS = 180; // ~3s average

type Star = {
  x: number;
  y: number;
  color: string;
  baseOpacity: number;
  currentOpacity: number;
  twinkle: boolean;
  twinkleSpeed: number;
  twinkleDirection: number;
  twinkleTimer: number;
};

type TrailPoint = { x: number; y: number; opacity: number };

type ShootingStar = {
  x: number;
  y: number;
  angle: number;
  speed: number;
  distance: number;
  trail: TrailPoint[];
};

export type StarField = {
  stars: Star[];
  shootingStars: ShootingStar[];
  ticksSinceRegen: number;
  ticksSinceShootingStar: number;
  nextShootingStarAt: number;
};

export function createStarField(): StarField {
  const area = WORLD_WIDTH * WORLD_HEIGHT;
  const numStars = Math.floor(area * STAR_DENSITY);
  const stars: Star[] = [];

  for (let i = 0; i < numStars; i++) {
    const gridX = Math.floor(Math.random() * (WORLD_WIDTH / PIXEL_SIZE)) * PIXEL_SIZE;
    const gridY = Math.floor(Math.random() * (WORLD_HEIGHT / PIXEL_SIZE)) * PIXEL_SIZE;
    const color = STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)] ?? "#FFFFFF";

    stars.push({
      x: gridX,
      y: gridY,
      color,
      baseOpacity: Math.random() * 0.5 + 0.5,
      currentOpacity: Math.random() * 0.5 + 0.5,
      twinkle: Math.random() < TWINKLE_PROBABILITY,
      twinkleSpeed: MIN_TWINKLE_SPEED + Math.random() * (MAX_TWINKLE_SPEED - MIN_TWINKLE_SPEED),
      twinkleDirection: -1,
      twinkleTimer: 0,
    });
  }

  return {
    stars,
    shootingStars: [],
    ticksSinceRegen: 0,
    ticksSinceShootingStar: 0,
    nextShootingStarAt: Math.floor(Math.random() * SHOOTING_STAR_SPAWN_TICKS) + 120,
  };
}

export function updateStarField(field: StarField): void {
  // Twinkle
  for (const star of field.stars) {
    if (!star.twinkle) continue;
    star.twinkleTimer += 1 / 60;
    if (star.twinkleTimer >= star.twinkleSpeed) {
      star.twinkleTimer = 0;
      star.twinkleDirection *= -1;
    }
    const progress = star.twinkleTimer / star.twinkleSpeed;
    star.currentOpacity =
      progress < 0.5
        ? star.twinkleDirection < 0 ? star.baseOpacity : star.baseOpacity * 0.3
        : star.twinkleDirection < 0 ? star.baseOpacity * 0.3 : star.baseOpacity;
  }

  // Regenerate some stars periodically
  field.ticksSinceRegen++;
  if (field.ticksSinceRegen >= REGEN_INTERVAL_TICKS) {
    field.ticksSinceRegen = 0;
    const num = Math.max(1, Math.floor(field.stars.length * REGEN_PERCENT));
    for (let i = 0; i < num; i++) {
      const idx = Math.floor(Math.random() * field.stars.length);
      const gridX = Math.floor(Math.random() * (WORLD_WIDTH / PIXEL_SIZE)) * PIXEL_SIZE;
      const gridY = Math.floor(Math.random() * (WORLD_HEIGHT / PIXEL_SIZE)) * PIXEL_SIZE;
      const color = STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)] ?? "#FFFFFF";
      field.stars[idx] = {
        x: gridX,
        y: gridY,
        color,
        baseOpacity: Math.random() * 0.5 + 0.5,
        currentOpacity: Math.random() * 0.5 + 0.5,
        twinkle: Math.random() < TWINKLE_PROBABILITY,
        twinkleSpeed: MIN_TWINKLE_SPEED + Math.random() * (MAX_TWINKLE_SPEED - MIN_TWINKLE_SPEED),
        twinkleDirection: -1,
        twinkleTimer: 0,
      };
    }
  }

  // Shooting stars
  field.ticksSinceShootingStar++;
  if (field.ticksSinceShootingStar >= field.nextShootingStarAt) {
    field.ticksSinceShootingStar = 0;
    field.nextShootingStarAt = Math.floor(Math.random() * SHOOTING_STAR_SPAWN_TICKS) + 120;
    const x = Math.random() * WORLD_WIDTH;
    field.shootingStars.push({
      x,
      y: 0,
      angle: 45 + Math.random() * 90,
      speed: Math.random() * 2 + 3,
      distance: 0,
      trail: [],
    });
  }

  // Update shooting stars
  field.shootingStars = field.shootingStars
    .map((s) => {
      const rad = (s.angle * Math.PI) / 180;
      const nx = s.x + s.speed * Math.cos(rad);
      const ny = s.y + s.speed * Math.sin(rad);
      const nd = s.distance + s.speed;

      const trail = [...s.trail];
      if (nd % 8 < s.speed) {
        trail.push({ x: s.x, y: s.y, opacity: 1 });
      }

      return {
        ...s,
        x: nx,
        y: ny,
        distance: nd,
        trail: trail
          .map((p) => ({ ...p, opacity: p.opacity - 0.1 }))
          .filter((p) => p.opacity > 0),
      };
    })
    .filter(
      (s) =>
        s.x >= -30 && s.x <= WORLD_WIDTH + 30 &&
        s.y >= -30 && s.y <= WORLD_HEIGHT + 30,
    );
}

export function drawStarField(ctx: CanvasRenderingContext2D, field: StarField): void {
  // Background stars
  for (const star of field.stars) {
    ctx.fillStyle = star.color;
    ctx.globalAlpha = star.currentOpacity;
    ctx.fillRect(star.x, star.y, PIXEL_SIZE, PIXEL_SIZE);
  }
  ctx.globalAlpha = 1;

  // Shooting stars
  for (const star of field.shootingStars) {
    const rad = (star.angle * Math.PI) / 180;

    // Trail
    for (const point of star.trail) {
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.rotate(rad);
      ctx.translate(-point.x, -point.y);
      ctx.fillStyle = `rgba(180, 242, 255, ${point.opacity})`;
      ctx.fillRect(point.x, point.y, SHOOTING_STAR_PIXEL_SIZE, SHOOTING_STAR_PIXEL_SIZE);
      ctx.restore();
    }

    // Head
    ctx.save();
    ctx.translate(star.x, star.y);
    ctx.rotate(rad);
    ctx.translate(-star.x, -star.y);
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 1;
    const w = 4, h = 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x === 0 && y === 1) || (x === 3 && y === 0)) continue;
        ctx.fillRect(
          star.x + x * SHOOTING_STAR_PIXEL_SIZE,
          star.y + y * SHOOTING_STAR_PIXEL_SIZE,
          SHOOTING_STAR_PIXEL_SIZE,
          SHOOTING_STAR_PIXEL_SIZE,
        );
      }
    }
    ctx.restore();
  }
}
