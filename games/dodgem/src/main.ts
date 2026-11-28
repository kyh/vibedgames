import { createTouchControls, probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { Reflex } from "@vibedgames/playtest";
import "@fontsource/silkscreen/400.css";
import "@fontsource/silkscreen/700.css";
import * as THREE from "three";

import { isMuted, setAudioPaused, setMuted, setWorldLevel, unlockAudio } from "./audio/sfx";
import { IS_TOUCH, Input } from "./input/input";
import { joinRoom } from "./net/session";
import { pauseOverlay } from "./pause-overlay";
import { Hud } from "./render/hud";
import { GameScene } from "./scenes/game-scene";
import type { GameDiagnostics } from "./scenes/game-scene";
import { FALLBACK_MS, MAX_DT, MAX_PLAYERS, ROOM_ID } from "./shared/constants";
import { CAR_KINDS } from "./sim/kinds";
import type { CarKind } from "./sim/kinds";

const CAR_KEY = "dodgem:car";
const COLOURS = 8;

const isKind = (value: unknown): value is CarKind => CAR_KINDS.some((kind) => kind === value);

const savedCar = () => {
  const fresh = { colour: Math.floor(Math.random() * COLOURS), kind: CAR_KINDS[0] };

  try {
    const [kind, colour] = (window.localStorage.getItem(CAR_KEY) ?? "").split(":");
    const index = Number(colour);

    return isKind(kind) && Number.isInteger(index) && index >= 0 && index < COLOURS
      ? { colour: index, kind }
      : fresh;
  } catch {
    return fresh;
  }
};

const saveCar = (kind: CarKind, colour: number) => {
  try {
    window.localStorage.setItem(CAR_KEY, `${kind}:${colour}`);

    return true;
  } catch {
    return false;
  }
};

const container = document.querySelector("#game");

if (!container) {
  throw new Error("missing #game container");
}

if (IS_TOUCH) {
  document.body.classList.add("touch");
}

const webgl = probeWebGL();

if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });

container.append(renderer.domElement);

renderer.domElement.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});

await document.fonts.load("400 16px 'Silkscreen'").catch(() => null);

const playtest = isPlaytestRequested();

const client = joinRoom({
  fallbackMs: FALLBACK_MS,
  maxPlayers: MAX_PLAYERS,
  offline: playtest,
  onEvent: (event, payload, from) => {
    game.onRoomEvent(event, payload, from);
  },
  room: ROOM_ID,
});

const input = new Input("#18bfb4");

input.setTouchVisible(false);

const hud = new Hud({
  onGarage: () => {
    game.leave();
  },
  onPick: (kind, colour) => {
    game.setLoadout(kind, colour);
    saveCar(kind, colour);
  },
  onStart: () => {
    unlockAudio();
    game.start();
  },
});

const sunParam = new URLSearchParams(window.location.search).get("sun");
const sunSize = sunParam === null ? 1024 : Number(sunParam) || 0;

const game = new GameScene(
  client,
  input,
  hud,
  renderer,
  IS_TOUCH ? Math.min(512, sunSize) : sunSize,
);

const car = savedCar();

game.setLoadout(car.kind, car.colour);

hud.setPick(car.kind, car.colour, false);

game.resize(window.innerWidth, window.innerHeight);

window.addEventListener("resize", () => {
  game.resize(window.innerWidth, window.innerHeight);
});

window.addEventListener("pointerdown", () => {
  unlockAudio();

  if (!game.playing) {
    setWorldLevel(0.25);
  }
});

const PICKS = new Map<string, readonly [number, number]>([
  ["ArrowDown", [0, 1]],
  ["ArrowLeft", [-1, 0]],
  ["ArrowRight", [1, 0]],
  ["ArrowUp", [0, -1]],
  ["KeyA", [-1, 0]],
  ["KeyD", [1, 0]],
  ["KeyS", [0, 1]],
  ["KeyW", [0, -1]],
]);

window.addEventListener("keydown", (event) => {
  unlockAudio();

  if (event.repeat) {
    return;
  }

  const pick = game.playing ? undefined : PICKS.get(event.code);

  if (event.code === "KeyM") {
    setMuted(!isMuted());
  } else if (event.code === "Enter" || event.code === "Space") {
    game.start();
  } else if (pick) {
    hud.nudgePick(pick[0], pick[1]);
  }
});

createTouchControls();

let paused = false;

setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    paused = true;
    game.setPaused(true);
    setAudioPaused(true);
  },
  onResume: () => {
    pauseOverlay.hide();
    paused = false;
    game.setPaused(false);
    setAudioPaused(false);
  },
});

type Diagnostics = GameDiagnostics & { paused: boolean };

const diag: Diagnostics = {
  attackReady: true,
  boost: 1,
  car: "bumper",
  complete: false,
  cube: { ahead: 0, distance: 99, side: 0 },
  damage: 0,
  edge: 9,
  entities: 0,
  falls: 0,
  frame: 0,
  home: { ahead: 0, side: 0 },
  knockOffs: 0,
  paused: false,
  phase: "title",
  place: 1,
  player: { x: 0, y: 0 },
  range: 4.6,
  rival: { ahead: 0, damage: 0, distance: 99, edge: 9, side: 0 },
  score: 0,
  special: "",
  threat: 0,
  timeLeft: 120,
};

publishDiagnostics(() => diag);

const towards = (ahead: number, side: number) => {
  const size = Math.hypot(ahead, side) || 1;
  const keys = ["ArrowUp"];

  if (side / size > 0.2 || (ahead < 0 && side >= 0)) {
    keys.push("ArrowRight");
  } else if (side / size < -0.2 || ahead < 0) {
    keys.push("ArrowLeft");
  }

  return keys;
};

const fightKeys = (d: Diagnostics, boost: boolean) => {
  if (d.edge < 2.4 || d.threat > 0.5) {
    return towards(d.home.ahead, d.home.side);
  }

  const keys = towards(d.rival.ahead, d.rival.side);
  const lined = d.rival.ahead > 0 && Math.abs(d.rival.side) < Math.max(1.6, d.rival.distance * 0.3);
  const close = d.rival.distance < d.range && (lined || d.range < 4);

  if (close && d.attackReady && d.frame % 3 === 0) {
    keys.push("Space");
  }

  if (d.special !== "" && d.rival.distance < 9 && d.frame % 20 === 0) {
    keys.push("KeyE");
  }

  if (boost && d.rival.distance > 9 && d.boost > 0.4) {
    keys.push("ShiftLeft");
  }

  return keys;
};

const fight: (boost: boolean) => Reflex<Diagnostics> = (boost) => (d) =>
  d && d.phase === "play" ? { keys: fightKeys(d, boost) } : undefined;

const timer = new THREE.Timer();
let beatAt = performance.now();

// WARNING: a hidden tab gets no animation frames, and a host that stops stepping freezes every bot in the room.
setInterval(() => {
  const now = performance.now();
  const gap = Math.min(1.5, (now - beatAt) / 1000);
  beatAt = now;

  if (document.hidden && client.isHost && client.connectionStatus === "connected") {
    for (let left = gap; left > 0; left -= MAX_DT) {
      game.update(Math.min(left, MAX_DT));
    }
  }
}, 250);

document.addEventListener("visibilitychange", () => {
  setAudioPaused(document.hidden || paused);
});

renderer.setAnimationLoop((time) => {
  timer.update(time);
  game.update(Math.min(timer.getDelta(), MAX_DT));
  game.render();
  diag.paused = paused;
  game.writeDiagnostics(diag);
});

if (import.meta.env.DEV || playtest) {
  publishTestHooks({
    seed: () => {
      game.restart();
    },
    setState: (name) => (game.setTestState(name) ? { state: name } : undefined),
  });

  publishPlaytest<Diagnostics>({
    goal: [
      "Car sumo on a big board with no walls: eight cars, two minutes. Knock rivals over the edge or into a hole; each knock-off is a point (game.score, game.knockOffs). Falling off on your own costs one (game.falls counts every fall). Every hit adds damage (game.damage, game.rival.damage): the more a car carries, the further the next hit throws it.",
      "The camera sits behind your car. ArrowUp drives ahead, ArrowLeft and ArrowRight steer, ArrowDown backs up. game.rival is the nearest rival you can hit as you see it: ahead of your nose (negative: behind you), side to your right (negative: left), distance in car units; rival.edge is how close THEY are to an edge. game.edge is how close YOU are to an edge or hole: under 2.5 is danger. game.threat above 0.5 means something on the board is about to hit you. game.cube is the nearest power cube: drive over it to pick up a special (game.special), and every move uses it when a rival is close.",
      "Default to chase. Use chase_boost when the rival is far (distance above 9) and game.boost is above 0.4. Use retreat when game.edge is under 3 or after being hit. Use grab when game.special is empty and game.cube.distance is under 20. Every move attacks by itself when a rival is in reach and game.attackReady is true.",
    ].join(" "),
    minDisplacement: 1,
    move: {
      chase: {
        description: "Drive at the nearest rival and attack when in reach",
        reflex: fight(false),
      },
      chase_boost: {
        description:
          "Boost at the nearest rival and attack when in reach: a faster hit throws further",
        reflex: fight(true),
      },
      grab: {
        description: "Drive to the nearest power cube",
        reflex: (d) =>
          d && d.phase === "play" && d.cube.distance < 99
            ? { keys: towards(d.cube.ahead, d.cube.side) }
            : undefined,
      },
      retreat: {
        description: "Drive to the nearest safe ground, away from the edges and the board's toys",
        reflex: (d) =>
          d && d.phase === "play" ? { keys: towards(d.home.ahead, d.home.side) } : undefined,
      },
    },
  });
}

if (import.meta.env.DEV) {
  Object.assign(window, { __dodgem: { client, game } });
}
