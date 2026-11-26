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
  onChassis: (index) => {
    game.setChassis(index);
  },
  onItem: () => {
    input.queueItem();
  },
  onStart: () => {
    unlockAudio();
    game.start();
  },
});

const sunParam = new URLSearchParams(window.location.search).get("sun");
const sunLate = sunParam === "late";
const sunSize = sunParam === null || sunLate ? 1024 : Number(sunParam) || 0;

const game = new GameScene(
  client,
  input,
  hud,
  renderer,
  IS_TOUCH ? Math.min(512, sunSize) : sunSize,
);

if (sunLate) {
  game.setTestState("sun-off");
}

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
  } else if (event.code === "KeyC") {
    game.toggleCamera();
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
  bendAhead: 0,
  boosting: false,
  complete: false,
  driftTier: 0,
  drifting: false,
  entities: 0,
  frame: 0,
  item: "",
  lane: 0,
  lap: 1,
  orbs: 0,
  paused: false,
  phase: "title",
  place: 1,
  player: { x: 0, y: 0 },
  score: 0,
  speed: 0,
  steerError: 0,
  surface: "road",
  tooFast: false,
  wrongWay: false,
};

publishDiagnostics(() => diag);

const driveKeys = (d: Diagnostics, lane: number, drift: boolean) => {
  const error = d.steerError + (lane - d.lane) * 0.35;
  const keys = [d.tooFast ? "ArrowDown" : "ArrowUp"];

  if (error > 0.06) {
    keys.push("ArrowRight");
  } else if (error < -0.06) {
    keys.push("ArrowLeft");
  }

  const intoBend = Math.sign(d.bendAhead) === Math.sign(error) && Math.abs(d.bendAhead) > 0.03;

  if (drift && intoBend && d.surface !== "shoulder" && d.driftTier < 3) {
    keys.push("Space");
  }

  if (d.item !== "" && d.frame % 2 === 0) {
    keys.push("KeyE");
  }

  return keys;
};

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

  const drive: (lane: number, drift: boolean) => Reflex<Diagnostics> = (lane, drift) => (d) =>
    d && d.phase !== "title" && d.phase !== "results"
      ? { keys: driveKeys(d, lane, drift) }
      : undefined;

  publishPlaytest<Diagnostics>({
    goal: [
      "A three-lap kart race against seven rivals; finish as high as you can (game.place, 1 is first; game.complete is true once you cross the line).",
      "Every kart paints the road behind it. game.surface says what you are on: 'own' (your paint: faster), 'rival' (someone else's: slippery and slower), 'road' (bare), 'shoulder' (off the road: very slow, get back on).",
      "game.lane is where you are across the road, -1 left edge to 1 right edge. game.bendAhead is the sharpest bend coming, + for a right-hander. Every move brakes by itself when game.tooFast is true. Default to race_centre. Switch lanes when game.surface has been 'rival' for a while. Use drift_corner when |game.bendAhead| is above 0.03: it slides the bend and releases a boost. game.orbs (0-10) raises your top speed: drive through the gold rings. game.item names the item in hand; every move plays it by itself.",
    ].join(" "),
    minDisplacement: 1,
    move: {
      drift_corner: {
        description: "Hold the gas and drift through the coming bend, boosting out of it",
        reflex: drive(0, true),
      },
      race_centre: {
        description: "Hold the gas and follow the middle of the road",
        reflex: drive(0, false),
      },
      race_left: {
        description: "Hold the gas and run the left side of the road",
        reflex: drive(-0.55, false),
      },
      race_right: {
        description: "Hold the gas and run the right side of the road",
        reflex: drive(0.55, false),
      },
    },
  });
}

if (import.meta.env.DEV) {
  Object.assign(window, { __tabletopTurbo: { client, game } });
}
