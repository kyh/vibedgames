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

import { isMuted, setAudioPaused, setMuted, unlockAudio } from "./audio/sfx";
import { IS_TOUCH, Input } from "./input/input";
import { joinRoom } from "./net/session";
import { pauseOverlay } from "./pause-overlay";
import { Hud } from "./render/hud";
import { GameScene } from "./scenes/game-scene";
import type { GameDiagnostics } from "./scenes/game-scene";
import { FALLBACK_MS, LOCAL_COLOR, MAX_DT, MAX_PLAYERS, ROOM_ID } from "./shared/constants";

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

const input = new Input(LOCAL_COLOR);

input.setTouchVisible(false);

const hud = new Hud({
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

game.resize(window.innerWidth, window.innerHeight);

window.addEventListener("resize", () => {
  game.resize(window.innerWidth, window.innerHeight);
});

window.addEventListener("pointerdown", unlockAudio);

window.addEventListener("keydown", (event) => {
  unlockAudio();

  if (event.repeat) {
    return;
  }

  if (event.code === "KeyM") {
    setMuted(!isMuted());
  } else if (event.code === "Enter" || event.code === "Space") {
    game.start();
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
  boost: 1,
  centre: { dx: 0, dy: 0 },
  complete: false,
  edge: 9,
  entities: 0,
  falls: 0,
  frame: 0,
  item: "",
  knockOffs: 0,
  paused: false,
  phase: "title",
  place: 1,
  player: { x: 0, y: 0 },
  punchReady: true,
  rival: { distance: 99, dx: 0, dy: 0, edge: 9 },
  score: 0,
  threat: 0,
  timeLeft: 90,
};

publishDiagnostics(() => diag);

const towards = (dx: number, dy: number) => {
  const size = Math.hypot(dx, dy) || 1;
  const keys: string[] = [];

  if (dx / size > 0.38) {
    keys.push("ArrowRight");
  } else if (dx / size < -0.38) {
    keys.push("ArrowLeft");
  }

  if (dy / size > 0.38) {
    keys.push("ArrowDown");
  } else if (dy / size < -0.38) {
    keys.push("ArrowUp");
  }

  return keys;
};

const fightKeys = (d: Diagnostics, boost: boolean) => {
  if (d.edge < 2.4 || d.threat > 0.5) {
    return towards(d.centre.dx, d.centre.dy);
  }

  const keys = towards(d.rival.dx, d.rival.dy);

  if (d.rival.distance < 4.6 && d.punchReady && d.frame % 3 === 0) {
    keys.push("Space");
  }

  if (boost && d.rival.distance > 7 && d.boost > 0.4) {
    keys.push("ShiftLeft");
  }

  return keys;
};

const fight: (boost: boolean) => Reflex<Diagnostics> = (boost) => (d) =>
  d && d.phase === "play" ? { keys: fightKeys(d, boost) } : undefined;

const timer = new THREE.Timer();

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
      "Car sumo on a board with no walls: eight cars, 90 seconds. Knock rivals over the edge or into a hole with your bumper; each knock-off is a point (game.score, game.knockOffs). Falling off on your own costs one (game.falls counts every fall).",
      "The car drives the way you point: arrows are screen directions. game.rival is the nearest rival you can hit (dx right, dy down, distance in car units; rival.edge is how close THEY are to an edge). game.edge is how close YOU are to an edge or hole: under 2.5 is danger. game.threat above 0.5 means something on the board is about to hit you.",
      "Default to chase. Use chase_boost when the rival is far (distance above 8) and game.boost is above 0.4. Use retreat when game.edge is under 3 or after being hit. Every move punches by itself when a rival is in reach and game.punchReady is true.",
    ].join(" "),
    minDisplacement: 1,
    move: {
      chase: {
        description: "Drive at the nearest rival and punch when in reach",
        reflex: fight(false),
      },
      chase_boost: {
        description:
          "Boost at the nearest rival and punch when in reach: a faster hit throws further",
        reflex: fight(true),
      },
      retreat: {
        description: "Drive back to the middle of the board",
        reflex: (d) =>
          d && d.phase === "play" ? { keys: towards(d.centre.dx, d.centre.dy) } : undefined,
      },
    },
  });
}

if (import.meta.env.DEV) {
  Object.assign(window, { __tabletopTurbo: { client, game } });
}
