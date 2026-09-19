// Per-frame roster passes that are not owned by any one brawler: pushing
// overlapping bodies apart, and deciding who is hidden in a bush (which also
// feeds the grass shader's parting and reveal uniforms).

import { BRAWLER_RADIUS } from "./config";
import type { Brawler } from "./entities/brawler";
import type { Game } from "./game";
import { dist } from "./utils";

/** The grass shader tracks at most this many bodies parting it. */
const MAX_PUSHERS = 8;
/** A hidden brawler is revealed when the player comes within this distance. */
const BUSH_REVEAL_RANGE = 2.4;

/** Resolve body overlap symmetrically; airborne and downed brawlers do not collide. */
export const separateBrawlers = (brawlers: readonly Brawler[]): void => {
  const minGap = BRAWLER_RADIUS * 1.9;
  for (const [i, a] of brawlers.entries()) {
    if (!a.alive || a.airborne) {
      continue;
    }
    for (const b of brawlers.slice(i + 1)) {
      if (!b.alive || b.airborne) {
        continue;
      }
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d >= minGap || d < 1e-4) {
        continue;
      }
      const push = (minGap - d) * 0.5;
      const nx = dx / d;
      const nz = dz / d;
      a.root.position.x -= nx * push;
      a.root.position.z -= nz * push;
      b.root.position.x += nx * push;
      b.root.position.z += nz * push;
    }
  }
};

export const updateVisibility = (game: Game): void => {
  const player = game.player?.alive ? game.player : null;
  const pushers = game.world.grassUniforms.uPushers.value;
  let slot = 0;
  for (const b of game.brawlers) {
    let hidden = false;
    if (player && b !== player && b.alive && b.inBush && b.revealT <= 0) {
      hidden = dist(player.x, player.z, b.x, b.z) > BUSH_REVEAL_RANGE;
    }
    b.hidden = hidden;
    if (b.alive) {
      b.root.visible = !hidden;
    }
    if (slot < MAX_PUSHERS) {
      const speed = Math.min(1, b.vel.length() / 3);
      const weight = b.alive && !hidden && !b.airborne ? 0.55 + speed * 0.45 : 0;
      pushers[slot]?.set(b.x, b.z, 1.05, weight);
      slot += 1;
    }
  }
  while (slot < MAX_PUSHERS) {
    pushers[slot]?.set(0, 0, 1, 0);
    slot += 1;
  }
  const reveal = game.world.grassUniforms.uReveal.value;
  if (player) {
    reveal.set(player.x, player.z, 0, player.inBush ? 1 : 0);
  } else {
    reveal.set(0, 0, 0, 0);
  }
};
