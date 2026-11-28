import { CAR_KINDS, KINDS } from "../src/sim/kinds.ts";
import type { CarKind } from "../src/sim/kinds.ts";
import { playMatch } from "./match.mts";

interface Tally {
  seats: number;
  score: number;
  kills: number;
  falls: number;
  wins: number;
  swings: number;
  landed: number;
  own: number;
}

const rounds = Number(process.argv[2] ?? 60);
const tallies = new Map<CarKind, Tally>();
const causes = new Map<string, number>();
const used = new Map<string, number>();
let attacks = 0;
let hits = 0;

for (const kind of CAR_KINDS) {
  tallies.set(kind, {
    falls: 0,
    kills: 0,
    landed: 0,
    own: 0,
    score: 0,
    seats: 0,
    swings: 0,
    wins: 0,
  });
}

for (let round = 1; round <= rounds; round += 1) {
  const log = playMatch(round);
  const best = Math.max(...log.scores.values());
  const kills = new Map<string, number>();

  for (const event of log.events) {
    if (event.kind === "out" && event.by !== "") {
      kills.set(event.by, (kills.get(event.by) ?? 0) + 1);
    } else if (event.kind === "use") {
      used.set(event.special, (used.get(event.special) ?? 0) + 1);
    } else if (event.kind === "attack") {
      attacks += 1;
      const tally = tallies.get(log.kinds.get(event.key) ?? "bumper");

      if (tally) {
        tally.swings += 1;
      }
    } else if (event.kind === "hit") {
      hits += 1;
      const kind = log.kinds.get(event.hit.by);
      const tally = kind ? tallies.get(kind) : undefined;

      if (tally && kind && event.hit.how === KINDS[kind].attack) {
        tally.landed += 1;
      }
    }
  }

  for (const out of log.outs) {
    const kind = log.kinds.get(out.by);
    const tally = kind ? tallies.get(kind) : undefined;

    if (tally && kind && out.how === KINDS[kind].attack) {
      tally.own += 1;
    }
  }

  for (const [cause, count] of log.causes) {
    causes.set(cause, (causes.get(cause) ?? 0) + count);
  }

  for (const [key, kind] of log.kinds) {
    const tally = tallies.get(kind);

    if (tally) {
      tally.seats += 1;
      tally.score += log.scores.get(key) ?? 0;
      tally.kills += kills.get(key) ?? 0;
      tally.falls += log.falls.get(key) ?? 0;
      tally.wins += (log.scores.get(key) ?? 0) === best ? 1 : 0;
    }
  }
}

const lines = [`${rounds} rounds, ${attacks} attacks, ${hits} blows landed`];

for (const [kind, tally] of tallies) {
  const per = (v: number) => (v / Math.max(1, tally.seats)).toFixed(2).padStart(6);
  lines.push(
    `${kind.padEnd(8)} score ${per(tally.score)}  knock-offs ${per(tally.kills)}  falls ${per(tally.falls)}  wins ${per(tally.wins)}  swings ${per(tally.swings)}  landed ${per(tally.landed)}  own k.o. ${per(tally.own)}`,
  );
}

const sorted = (map: Map<string, number>) =>
  [...map]
    .toSorted((p, q) => q[1] - p[1])
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");

lines.push(`falls by cause: ${sorted(causes)}`, `specials used: ${sorted(used)}`);

process.stdout.write(`${lines.join("\n")}\n`);
