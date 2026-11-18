import { createTouchControls, probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { Reflex } from "@vibedgames/playtest";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource/chakra-petch/700-italic.css";
import * as THREE from "three";
import type { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";

import { isMuted, setAudioPaused, setMuted, unlockAudio } from "./audio/sfx";
import { IS_TOUCH, Input } from "./input/input";
import { joinRoom } from "./net/session";
import { pauseOverlay } from "./pause-overlay";
import { Hud } from "./render/hud";
import { buildPost } from "./render/post";
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
  // Module-level boot has no early return: the uncaught throw logs the reason and stops.
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

// A phone shares one GPU process across every tab: no multisampling, a capped
// pixel ratio and no bloom chain keep the allocation small enough to survive.
const renderer = new THREE.WebGLRenderer({
  antialias: !IS_TOUCH,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// Neutral keeps saturated colours saturated when they get bright: paint must not bleach.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.12;
container.append(renderer.domElement);
renderer.domElement.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});

// Signs, number plates and item boxes are drawn on canvases at boot: the
// display face has to be there first, or they are lettered in a fallback.
await Promise.all([
  document.fonts.load("italic 700 32px 'Chakra Petch'"),
  document.fonts.load("600 16px 'Chakra Petch'"),
]).catch(() => null);

const playtest = isPlaytestRequested();
const client = joinRoom({
  fallbackMs: FALLBACK_MS,
  maxPlayers: MAX_PLAYERS,
  // A playtest must drive its own race, never someone else's room.
  offline: playtest,
  onEvent: (event, payload, from) => game.onRoomEvent(event, payload, from),
  room: ROOM_ID,
});

const input = new Input(LOCAL_COLOR);
input.setTouchVisible(false);
const hud = new Hud({
  onChassis: (index) => game.setChassis(index),
  onItem: () => input.queueItem(),
  onStart: () => {
    unlockAudio();
    game.start();
  },
});
// Soft shadows are what ground everything; a phone goes without the shadow pass.
const SHADOW_MAP = IS_TOUCH ? 0 : 2048;
renderer.shadowMap.enabled = SHADOW_MAP > 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const game = new GameScene(client, input, hud, renderer, SHADOW_MAP);
game.resize(window.innerWidth / window.innerHeight);

// Desktop post: ambient occlusion in every crease and under every object,
// bloom keyed to the paint and the lamps, then a grade. Phones draw straight.
let composer: EffectComposer | null = null;
if (!IS_TOUCH) {
  composer = buildPost(renderer, game.scene, game.camera);
}

window.addEventListener("resize", () => {
  game.resize(window.innerWidth / window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer?.setSize(window.innerWidth, window.innerHeight);
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

// Bot-playtest telemetry (playtest skill contract): one object mutated in place.
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

/** Gas plus a correction towards `lane`; brakes for a bend it is too fast for, drifts one it can take. */
const driveKeys = (d: Diagnostics, lane: number, drift: boolean): string[] => {
  // Aim for the chosen lane on top of following the road.
  const error = d.steerError + (lane - d.lane) * 0.35;
  const keys = [d.tooFast ? "ArrowDown" : "ArrowUp"];
  if (error > 0.06) {
    keys.push("ArrowRight");
  } else if (error < -0.06) {
    keys.push("ArrowLeft");
  }
  // A drift only turns into its bend: hold it while the road still bends that way.
  const intoBend = Math.sign(d.bendAhead) === Math.sign(error) && Math.abs(d.bendAhead) > 0.03;
  if (drift && intoBend && d.surface !== "shoulder" && d.driftTier < 3) {
    keys.push("Space");
  }
  // Play whatever is in hand; the key is edge-triggered, so tap it on alternate frames.
  if (d.item !== "" && d.frame % 2 === 0) {
    keys.push("KeyE");
  }
  return keys;
};

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  game.update(Math.min(timer.getDelta(), MAX_DT));
  if (composer) {
    composer.render();
  } else {
    renderer.render(game.scene, game.camera);
  }
  diag.paused = paused;
  game.writeDiagnostics(diag);
});

if (import.meta.env.DEV || playtest) {
  publishTestHooks({
    seed: () => game.restart(),
    setState: (name) => (game.setTestState(name) ? { state: name } : undefined),
  });

  // Steering is a 60 fps job: every move is a reflex that holds the gas and
  // corrects towards the road ahead. The model picks the line and when to drift.
  const drive =
    (lane: number, drift: boolean): Reflex<Diagnostics> =>
    (d) =>
      d && d.phase !== "title" && d.phase !== "results"
        ? { keys: driveKeys(d, lane, drift) }
        : undefined;

  publishPlaytest<Diagnostics>({
    goal: [
      "A three-lap kart race against seven rivals; finish as high as you can (game.place, 1 is first; game.complete is true once you cross the line).",
      "Every kart paints the road behind it. game.surface says what you are on: 'own' (your paint: faster), 'rival' (someone else's: slippery and slower), 'road' (bare), 'shoulder' (off the road: very slow, get back on).",
      "game.lane is where you are across the road, -1 left edge to 1 right edge. game.bendAhead is the sharpest bend coming, + for a right-hander. Every move brakes by itself when game.tooFast is true. Default to race_centre. Switch lanes when game.surface has been 'rival' for a while. Use drift_corner when |game.bendAhead| is above 0.03: it slides the bend and releases a boost. game.orbs (0-10) raises your top speed: drive through the gold rings. game.item names the item in hand; every move plays it by itself.",
    ].join(" "),
    // The road is ~15 units wide and a kart covers ~8 units per decision.
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

// A handle for poking at the race from the console.
if (import.meta.env.DEV) {
  Object.assign(window, { __glowline: { client, game } });
}
