# Three.js Game Patterns

Patterns for building games with Three.js, beyond simple showcase scenes.

---

## Animation State Management

For characters that switch between idle, run, jump, death, etc.

### Finding and Playing Animations

```javascript
// After loading GLTF
const mixer = new THREE.AnimationMixer(model);
const animations = gltf.animations;

// Find animation by name (partial match)
function findAnimation(name) {
  return animations.find((clip) => clip.name.toLowerCase().includes(name.toLowerCase()));
}

// Play an animation
function playAnimation(name, { loop = true, timeScale = 1 } = {}) {
  const clip = findAnimation(name);
  if (!clip) return null;

  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce);
  action.clampWhenFinished = !loop; // Hold last frame if not looping
  action.timeScale = timeScale;
  action.play();

  return action;
}

// Usage
playAnimation("run"); // Loop running
playAnimation("jump", { loop: false, timeScale: 2 }); // One-shot, fast
playAnimation("death", { loop: false }); // One-shot, hold last frame
```

### Crossfading Between Animations

```javascript
let currentAction = null;

function switchAnimation(name, { fadeTime = 0.1, ...options } = {}) {
  const clip = findAnimation(name);
  if (!clip) return;

  const newAction = mixer.clipAction(clip);
  newAction.reset();
  newAction.setLoop(options.loop !== false ? THREE.LoopRepeat : THREE.LoopOnce);
  newAction.clampWhenFinished = !options.loop;
  newAction.timeScale = options.timeScale || 1;

  if (currentAction) {
    currentAction.fadeOut(fadeTime);
  }

  newAction.fadeIn(fadeTime).play();
  currentAction = newAction;
}

// Usage in game logic
if (jumping) {
  switchAnimation("jump", { loop: false, timeScale: 2.5 });
} else if (grounded) {
  switchAnimation("run");
}
```

---

## Facing Direction for Side-Scrollers

GLTF models typically face -Z (into the screen). For side-scrollers:

```javascript
function normalizeModel(model, targetHeight, faceDirection = "right") {
  // ... scaling logic ...

  // Rotate to face correct direction
  // GLTF default: faces -Z
  // To face +X (right): rotate +90° around Y
  // To face -X (left): rotate -90° around Y

  if (faceDirection === "right") {
    model.rotation.y = Math.PI / 2; // Face +X
  } else if (faceDirection === "left") {
    model.rotation.y = -Math.PI / 2; // Face -X
  }
  // 'none' or default: keep original facing

  return model;
}

// Usage
normalizeModel(playerModel, 2, "right"); // Player runs right
normalizeModel(enemyModel, 2, "left"); // Enemy approaches from right
```

---

## Game Loop with State Machine

```javascript
const GameState = {
  LOADING: "loading",
  MENU: "menu",
  PLAYING: "playing",
  PAUSED: "paused",
  GAME_OVER: "gameover",
};

const state = {
  current: GameState.LOADING,
  timeScale: 1.0, // For slow-mo effects
  score: 0,
};

const clock = new THREE.Clock();
const mixers = []; // All animation mixers

function gameLoop() {
  const dt = Math.min(clock.getDelta(), 0.1); // Cap delta for tab-away
  const scaledDt = dt * state.timeScale;

  // Always update animations (even in menu for idle anims)
  for (const mixer of mixers) {
    mixer.update(scaledDt);
  }

  switch (state.current) {
    case GameState.PLAYING:
      updatePlayer(scaledDt);
      updateObstacles(scaledDt);
      updateBackground(scaledDt);
      checkCollisions();
      updateScore(dt); // Real time, not scaled
      break;

    case GameState.PAUSED:
      // Render but don't update physics
      break;

    case GameState.MENU:
      // Light background animation
      updateBackground(dt * 0.3);
      break;
  }

  updateScreenEffects(dt);
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(gameLoop);
```

---

## Hitstop & Slow Motion (Time Scaling)

**Never drive time-scale effects with `setTimeout` or wall clock** — they desync from the simulation on frame drops, keep running while the game is paused or the tab is hidden, and stack incorrectly. Decay them in the game loop with the frame delta.

The rule for all feel effects: **gameplay reads the scaled delta; camera, shake, tweens, and HUD read the real delta.** If feedback is scaled too, the frozen moment is invisible.

```javascript
// Fields on state:
state.timeScale = 1;
state.hitstopRemaining = 0; // seconds, decays in REAL time

function hitstop(durationMs, scale = 0.05) {
  state.hitstopRemaining = Math.max(state.hitstopRemaining, durationMs / 1000);
  state.timeScale = scale;
}

function gameLoop() {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (state.hitstopRemaining > 0) {
    state.hitstopRemaining -= dt; // decay in REAL time
    if (state.hitstopRemaining <= 0) state.timeScale = 1;
  }
  const gameplayDt = dt * state.timeScale;

  // Gameplay reads the scaled delta so the world crawls...
  updatePlayer(gameplayDt);
  updateObstacles(gameplayDt);
  for (const mixer of mixers) mixer.update(gameplayDt);

  // ...but feedback reads the REAL delta so it stays live during the freeze.
  updateShake(dt);
  updateFov(dt);
  updateScore(dt); // score in real time — never affected by slow-mo

  renderer.render(scene, camera);
}
```

Recommended: **60–90ms at scale `0.05`** on heavy hits only. Hitstop on every minor event makes the game feel laggy instead of weighty. Never stop the render loop to freeze — the frame must keep drawing or the frozen moment can't be seen.

For longer slow-mo (bullet-time), set `state.timeScale = 0.3` and ease it back toward 1 in the loop: `state.timeScale += (1 - state.timeScale) * Math.min(1, dt * 5)`.

---

## Screen Effects

### Camera Shake (trauma-based)

Add **trauma** on events; shake magnitude is `trauma²`, so small events barely move the camera and big ones snap hard. Deterministic value noise instead of `Math.random()` — smooth, seedable, reproducible under test.

```javascript
const TRAUMA_DECAY = 1.4; // trauma units per second
const MAX_OFFSET = 0.55; // world units at full shake
const MAX_ROLL = 0.1; // radians at full shake

let trauma = 0;
let shakeTime = 0;

function addTrauma(amount) {
  trauma = Math.min(1, trauma + amount); // hard cap: stacked events can't fling the camera
}

// Deterministic value noise in [-1, 1]; per-axis seed keeps axes independent.
function pseudoNoise(t, seed) {
  const x = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

// Call every frame AFTER the camera's base transform is written (follow cam, lookAt).
// The offset never accumulates because the base transform is re-derived each frame.
function updateShake(dt) {
  shakeTime += dt;
  trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);
  if (trauma <= 0) return;
  const shake = trauma * trauma;
  const freq = shakeTime * 32;
  camera.position.x += MAX_OFFSET * shake * pseudoNoise(freq, 1);
  camera.position.y += MAX_OFFSET * shake * pseudoNoise(freq, 2);
  camera.rotation.z += MAX_ROLL * shake * pseudoNoise(freq, 3);
}

// Usage — trauma per event:
addTrauma(0.15); // pickup
addTrauma(0.4); // player hit
addTrauma(0.7); // explosion
```

Skipping the `trauma²` curve or the cap is the classic mistake: small events feel violent and stacked events launch the camera.

### FOV Punch

An additive FOV bump reads as acceleration or shock. Decay toward 0 with a ~200ms time constant. Applies to `camera.fov` (perspective), not `camera.zoom`.

```javascript
const BASE_FOV = 50;
let fovPunch = 0; // additive degrees

function punchFov(degrees) {
  fovPunch = Math.min(10, fovPunch + degrees); // additive, clamped
}

function updateFov(dt) {
  if (fovPunch <= 0.001) return;
  fovPunch *= Math.exp(-dt / 0.2); // ~200ms decay
  if (fovPunch < 0.001) fovPunch = 0;
  camera.fov = BASE_FOV + fovPunch;
  camera.updateProjectionMatrix(); // REQUIRED — without it the FOV never visibly changes
}

// Usage
punchFov(6); // boost / dash
punchFov(8); // explosion
```

### Screen Flash

A DOM overlay is cheaper than a render-target flash and never touches the 3D pipeline. Use `element.animate()` (WAAPI) — self-cleaning, no `setTimeout` bookkeeping:

```html
<div id="flash-overlay" style="position: fixed; inset: 0; pointer-events: none; opacity: 0;"></div>
```

```javascript
function flashScreen(color, durationMs = 100, peak = 0.5) {
  const overlay = document.getElementById("flash-overlay");
  overlay.style.backgroundColor = color;
  overlay.animate([{ opacity: peak }, { opacity: 0 }], { duration: durationMs, easing: "ease-out" });
}

// Usage
flashScreen("#4DEBFF", 150, 0.3); // cyan flash for near-miss
flashScreen("#ffffff", 100, 0.8); // white flash for explosion/death
```

### Impact Flash (material)

Pulse `emissiveIntensity` on the hit object and decay it in the loop. The material's `emissive` **color must be non-black** or nothing shows.

```javascript
function flashHit(material, peak = 2.4) {
  material.userData.baseEmissive ??= material.emissiveIntensity;
  material.emissiveIntensity = peak;
}

function updateFlashes(dt, materials) {
  for (const m of materials) {
    const base = m.userData.baseEmissive;
    if (base === undefined || m.emissiveIntensity <= base) continue;
    m.emissiveIntensity = Math.max(base, m.emissiveIntensity - dt * 10);
  }
}
```

---

## Squash & Stretch

Preserve volume: when the Y axis scales by `s`, counter-scale X/Z by `1 / sqrt(s)` — otherwise the model visibly grows/shrinks instead of deforming. Decay in the loop, not with `setTimeout` chains.

```javascript
let squashY = 1; // current Y scale; 1 = rest

// squash < 1 on impact/landing, stretch > 1 on jump takeoff
function squash(amount) {
  squashY = amount;
}

function updateSquash(dt, target) {
  // spring back toward 1 with overshoot (the bounce is the feel)
  squashY += (1 - squashY) * Math.min(1, dt * 14);
  const xz = 1 / Math.sqrt(squashY); // volume-preserving counter-scale
  target.scale.set(xz, squashY, xz);
}

// Usage — updateSquash(dt, playerVisual) runs in the loop
squash(1.15); // jump takeoff stretch
squash(0.85); // landing squash (0.75 for heavy impact)
```

Both should return to rest over ~180ms. Apply to a visual wrapper `Group`, never the physics body.

---

## Per-Event Tuning Table

Map each event to a full feedback stack — stronger events get more layers, not just bigger numbers:

| Event        | Feedback stack                                                              |
| ------------ | --------------------------------------------------------------------------- |
| Pickup       | scale pop + HUD counter punch + pitch-varied chime + `0.15` trauma          |
| Player hit   | hitstop 70ms + `0.4` trauma + impact flash + rumble 180ms                   |
| Enemy killed | hitstop 40ms + `0.3` trauma + impact flash + pitch-varied boom              |
| Boost / dash | FOV punch +6° + stretch 1.15 + whoosh                                       |
| Jump / land  | stretch 1.15 on takeoff, squash 0.85 on landing + `0.2` trauma on land      |
| Explosion    | hitstop 90ms + `0.7` trauma + white screen flash + FOV punch +8° + rumble   |

(SFX pitch variation and audio wiring: [`generated-assets.md`](generated-assets.md). Deeper engine-agnostic feel theory and 2D numbers: the `game-feel` skill.)

---

## Parallax Background Layers

Different scroll speeds create depth:

```javascript
const PARALLAX = {
  clouds: 0.1, // Very slow
  farTrees: 0.3, // Slow
  nearTrees: 0.5, // Medium
  crowd: 0.7, // Faster
  ground: 1.0, // Base speed
};

const layers = {
  clouds: [],
  farTrees: [],
  nearTrees: [],
  crowd: [],
};

function updateParallax(dt, baseSpeed) {
  for (const [layerName, objects] of Object.entries(layers)) {
    const speed = baseSpeed * PARALLAX[layerName] * dt;

    for (const obj of objects) {
      obj.position.x -= speed;

      // Wrap when off-screen
      if (obj.position.x < -30) {
        obj.position.x += 60; // Jump to right side
        // Randomize Z for variety on wrap
        obj.position.z = -5 - Math.random() * 10;
      }
    }
  }
}
```

---

## Object Pooling

For spawning/despawning obstacles:

```javascript
class ObjectPool {
  constructor(createFn, initialSize = 10) {
    this.createFn = createFn;
    this.pool = [];
    this.active = [];

    // Pre-populate
    for (let i = 0; i < initialSize; i++) {
      const obj = createFn();
      obj.visible = false;
      this.pool.push(obj);
    }
  }

  spawn(x, y, z) {
    let obj = this.pool.pop();

    if (!obj) {
      // Pool exhausted, create new
      obj = this.createFn();
    }

    obj.position.set(x, y, z);
    obj.visible = true;
    this.active.push(obj);

    return obj;
  }

  despawn(obj) {
    obj.visible = false;
    const idx = this.active.indexOf(obj);
    if (idx !== -1) this.active.splice(idx, 1);
    this.pool.push(obj);
  }

  // Call in game loop
  updateAll(callback) {
    // Iterate backwards for safe removal
    for (let i = this.active.length - 1; i >= 0; i--) {
      const shouldDespawn = callback(this.active[i]);
      if (shouldDespawn) {
        this.despawn(this.active[i]);
      }
    }
  }
}

// Usage
const obstaclePool = new ObjectPool(() => {
  return createObstacle(); // Your creation function
}, 15);

// Spawn
obstaclePool.spawn(12, 0, 0);

// Update loop
obstaclePool.updateAll((obstacle) => {
  obstacle.position.x -= scrollSpeed * dt;
  return obstacle.position.x < -14; // Return true to despawn
});
```

---

## Fixed Game Camera (Not OrbitControls)

For side-scrollers and fixed-view games:

```javascript
// Simple side-view camera
function setupGameCamera() {
  const camera = new THREE.PerspectiveCamera(45, 960 / 540, 0.1, 100);
  camera.position.set(2, 5, 16);
  camera.lookAt(2, 1, 0);
  return camera;
}

// Cinematic variant with slight tilt
function setupCinematicCamera() {
  const camera = new THREE.PerspectiveCamera(50, 960 / 540, 0.1, 100);
  camera.position.set(0, 8, 14);
  camera.lookAt(2, 1, 0);
  camera.rotation.z = 0.03; // Slight Dutch angle
  return camera;
}

// Toggle between camera modes
let cinematicMode = false;
const cameraPositions = {
  simple: { x: 2, y: 5, z: 16, fov: 45, tilt: 0 },
  cinematic: { x: 0, y: 8, z: 14, fov: 50, tilt: 0.03 },
};

function toggleCameraMode() {
  cinematicMode = !cinematicMode;
  const pos = cinematicMode ? cameraPositions.cinematic : cameraPositions.simple;

  camera.position.set(pos.x, pos.y, pos.z);
  camera.fov = pos.fov;
  camera.rotation.z = pos.tilt;
  camera.updateProjectionMatrix();
  camera.lookAt(2, 1, 0);
}
```

---

## Near-Miss Detection

For rewarding close calls:

```javascript
function checkNearMiss(player, obstacle, threshold = 0.8) {
  // Only check when obstacle passes player
  if (obstacle.position.x > player.position.x) return false;
  if (obstacle.passed) return false;

  // Mark as passed
  obstacle.passed = true;

  // Check if it was close (player was above obstacle)
  const verticalGap = player.position.y - obstacle.height;

  if (verticalGap > 0 && verticalGap < threshold) {
    triggerNearMissReward();
    return true;
  }

  return false;
}

function triggerNearMissReward() {
  state.score += 15;
  flashScreen("#4DEBFF", 0.15);
  triggerSlowMo(0.5, 0.15);
  showFloatingText("CLOSE!", "#4DEBFF");
}
```

---

## Floating Text Popup

```html
<style>
  .floating-text {
    position: absolute;
    font-weight: bold;
    pointer-events: none;
    animation: floatUp 0.6s ease-out forwards;
  }
  @keyframes floatUp {
    0% {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    100% {
      opacity: 0;
      transform: translateY(-40px) scale(1.2);
    }
  }
</style>
```

```javascript
function showFloatingText(text, color, x = "50%", y = "35%") {
  const popup = document.createElement("div");
  popup.className = "floating-text";
  popup.textContent = text;
  popup.style.color = color;
  popup.style.left = x;
  popup.style.top = y;
  popup.style.transform = "translateX(-50%)";
  popup.style.fontSize = "1.4rem";
  popup.style.textShadow = `0 0 10px ${color}`;

  document.getElementById("ui").appendChild(popup);

  setTimeout(() => popup.remove(), 600);
}
```

---

## Best Practices Summary

| Pattern                    | When to Use                                  |
| -------------------------- | -------------------------------------------- |
| Animation state management | Characters with multiple animations          |
| Facing direction rotation  | Side-scrollers with GLTF models              |
| Game state machine         | Any game with menu/play/pause/gameover       |
| Hitstop / time scaling     | Weight on heavy contact, slow-mo moments     |
| Trauma camera shake        | Death, heavy impacts (trauma², capped)       |
| FOV punch                  | Boost, dash, explosion shock                 |
| Screen flash               | Near-miss, milestones, damage                |
| Squash & stretch           | Jump, land, any snappy motion (volume-preserving) |
| Parallax layers            | Scrolling games with depth                   |
| Object pooling             | Spawning many objects (obstacles, particles) |
| Fixed camera               | Games (not model viewers)                    |
| Near-miss detection        | Rewarding close calls                        |

---

## Anti-Patterns

❌ **Creating objects in the game loop**

```javascript
// BAD - creates garbage every frame
function update() {
  const obstacle = new Obstacle(); // Memory leak!
}
```

❌ **Mixing real time and game time inconsistently**

```javascript
// BAD - score affected by slow-mo
state.score += dt * state.timeScale;

// GOOD - score uses real time
state.score += dt;
```

❌ **Driving effects with `setTimeout` / wall clock**

```javascript
// BAD - keeps running while paused/tab-hidden, desyncs on frame drops,
// stacks incorrectly when two hits land close together
setTimeout(() => (state.timeScale = 1), 200);

// GOOD - decay in the game loop with the frame delta
state.hitstopRemaining -= dt;
```

❌ **Forgetting to clean up animation mixers**

```javascript
// BAD - mixer keeps running, memory leak
scene.remove(enemy);

// GOOD - remove mixer from update list
const idx = mixers.indexOf(enemy.mixer);
if (idx !== -1) mixers.splice(idx, 1);
scene.remove(enemy);
```
