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
    return animations.find(clip =>
        clip.name.toLowerCase().includes(name.toLowerCase())
    );
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
playAnimation('run');                          // Loop running
playAnimation('jump', { loop: false, timeScale: 2 }); // One-shot, fast
playAnimation('death', { loop: false });       // One-shot, hold last frame
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
    switchAnimation('jump', { loop: false, timeScale: 2.5 });
} else if (grounded) {
    switchAnimation('run');
}
```

---

## Facing Direction for Side-Scrollers

GLTF models typically face -Z (into the screen). For side-scrollers:

```javascript
function normalizeModel(model, targetHeight, faceDirection = 'right') {
    // ... scaling logic ...

    // Rotate to face correct direction
    // GLTF default: faces -Z
    // To face +X (right): rotate +90° around Y
    // To face -X (left): rotate -90° around Y

    if (faceDirection === 'right') {
        model.rotation.y = Math.PI / 2;  // Face +X
    } else if (faceDirection === 'left') {
        model.rotation.y = -Math.PI / 2; // Face -X
    }
    // 'none' or default: keep original facing

    return model;
}

// Usage
normalizeModel(playerModel, 2, 'right');  // Player runs right
normalizeModel(enemyModel, 2, 'left');    // Enemy approaches from right
```

---

## Game Loop with State Machine

```javascript
const GameState = {
    LOADING: 'loading',
    MENU: 'menu',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'gameover'
};

const state = {
    current: GameState.LOADING,
    timeScale: 1.0,  // For slow-mo effects
    score: 0
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

## Time Scaling (Slow Motion)

```javascript
// Trigger slow-mo
function triggerSlowMo(factor, duration) {
    state.timeScale = factor;

    setTimeout(() => {
        state.timeScale = 1.0;
    }, duration * 1000);
}

// Usage
triggerSlowMo(0.3, 0.2);  // 30% speed for 0.2 seconds

// Gradual return to normal
function triggerSlowMoSmooth(factor, holdTime, rampTime) {
    state.timeScale = factor;

    setTimeout(() => {
        const startTime = performance.now();
        const rampMs = rampTime * 1000;

        function ramp() {
            const elapsed = performance.now() - startTime;
            const t = Math.min(elapsed / rampMs, 1);
            state.timeScale = factor + (1 - factor) * t;

            if (t < 1) requestAnimationFrame(ramp);
        }
        ramp();
    }, holdTime * 1000);
}

// Usage: 0.15x for 0.2s, then ramp to 1x over 0.12s
triggerSlowMoSmooth(0.15, 0.2, 0.12);
```

---

## Screen Effects

### Camera Shake

```javascript
const cameraBasePos = { x: 2, y: 5, z: 16 };
let shakeIntensity = 0;
let shakeDuration = 0;

function shakeScreen(intensity, duration) {
    shakeIntensity = intensity;
    shakeDuration = duration;
}

function updateShake(dt) {
    if (shakeDuration > 0) {
        shakeDuration -= dt;
        const decay = shakeDuration / 0.3; // Assume 0.3s base duration
        const offset = shakeIntensity * decay;

        camera.position.x = cameraBasePos.x + (Math.random() - 0.5) * offset;
        camera.position.y = cameraBasePos.y + (Math.random() - 0.5) * offset;
    } else {
        camera.position.x = cameraBasePos.x;
        camera.position.y = cameraBasePos.y;
    }
}

// Usage
shakeScreen(0.5, 0.35); // Intensity 0.5 units, 0.35 seconds
```

### Screen Flash

```html
<div id="flash-overlay" style="
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.08s;
"></div>
```

```javascript
function flashScreen(color, duration) {
    const overlay = document.getElementById('flash-overlay');
    overlay.style.backgroundColor = color;
    overlay.style.opacity = 0.3;

    setTimeout(() => {
        overlay.style.opacity = 0;
    }, duration * 1000);
}

// Usage
flashScreen('#4DEBFF', 0.15);  // Cyan flash for near-miss
flashScreen('#ffffff', 0.08);  // White flash for impact
```

### Zoom Pulse

```javascript
let zoomTarget = 1.0;
let zoomCurrent = 1.0;

function zoomPulse(scale, duration) {
    zoomTarget = scale;

    setTimeout(() => {
        zoomTarget = 1.0;
    }, duration * 500); // Half duration for in, half for out
}

function updateZoom(dt) {
    // Smooth interpolation
    zoomCurrent += (zoomTarget - zoomCurrent) * dt * 10;

    // Apply to camera FOV (for perspective) or frustum (for ortho)
    camera.zoom = zoomCurrent;
    camera.updateProjectionMatrix();
}

// Usage
zoomPulse(1.02, 0.2);  // 2% zoom in, 0.2s total
```

---

## Squash & Stretch

For jump anticipation and landing impact:

```javascript
function setModelScale(model, sx, sy, sz) {
    model.scale.set(sx, sy, sz);
}

// Jump anticipation
function jumpAnticipation(model) {
    setModelScale(model, 1.15, 0.8, 1.15);  // Squash

    setTimeout(() => {
        setModelScale(model, 1, 1, 1);       // Restore
    }, 80);
}

// Landing impact
function landingSquash(model) {
    setModelScale(model, 1.2, 0.75, 1.2);   // Heavy squash

    setTimeout(() => {
        setModelScale(model, 0.95, 1.1, 0.95); // Overshoot
    }, 60);

    setTimeout(() => {
        setModelScale(model, 1, 1, 1);        // Settle
    }, 150);
}
```

---

## Parallax Background Layers

Different scroll speeds create depth:

```javascript
const PARALLAX = {
    clouds: 0.1,     // Very slow
    farTrees: 0.3,   // Slow
    nearTrees: 0.5,  // Medium
    crowd: 0.7,      // Faster
    ground: 1.0      // Base speed
};

const layers = {
    clouds: [],
    farTrees: [],
    nearTrees: [],
    crowd: []
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
    const camera = new THREE.PerspectiveCamera(45, 960/540, 0.1, 100);
    camera.position.set(2, 5, 16);
    camera.lookAt(2, 1, 0);
    return camera;
}

// Cinematic variant with slight tilt
function setupCinematicCamera() {
    const camera = new THREE.PerspectiveCamera(50, 960/540, 0.1, 100);
    camera.position.set(0, 8, 14);
    camera.lookAt(2, 1, 0);
    camera.rotation.z = 0.03; // Slight Dutch angle
    return camera;
}

// Toggle between camera modes
let cinematicMode = false;
const cameraPositions = {
    simple: { x: 2, y: 5, z: 16, fov: 45, tilt: 0 },
    cinematic: { x: 0, y: 8, z: 14, fov: 50, tilt: 0.03 }
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
    flashScreen('#4DEBFF', 0.15);
    triggerSlowMo(0.5, 0.15);
    showFloatingText('CLOSE!', '#4DEBFF');
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
    0% { opacity: 1; transform: translateY(0) scale(1); }
    100% { opacity: 0; transform: translateY(-40px) scale(1.2); }
}
</style>
```

```javascript
function showFloatingText(text, color, x = '50%', y = '35%') {
    const popup = document.createElement('div');
    popup.className = 'floating-text';
    popup.textContent = text;
    popup.style.color = color;
    popup.style.left = x;
    popup.style.top = y;
    popup.style.transform = 'translateX(-50%)';
    popup.style.fontSize = '1.4rem';
    popup.style.textShadow = `0 0 10px ${color}`;

    document.getElementById('ui').appendChild(popup);

    setTimeout(() => popup.remove(), 600);
}
```

---

## Best Practices Summary

| Pattern | When to Use |
|---------|-------------|
| Animation state management | Characters with multiple animations |
| Facing direction rotation | Side-scrollers with GLTF models |
| Game state machine | Any game with menu/play/pause/gameover |
| Time scaling | Slow-mo for impact moments |
| Screen shake | Death, heavy impacts |
| Screen flash | Near-miss, milestones, damage |
| Squash & stretch | Jump, land, any snappy motion |
| Parallax layers | Scrolling games with depth |
| Object pooling | Spawning many objects (obstacles, particles) |
| Fixed camera | Games (not model viewers) |
| Near-miss detection | Rewarding close calls |

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

❌ **Forgetting to clean up animation mixers**
```javascript
// BAD - mixer keeps running, memory leak
scene.remove(enemy);

// GOOD - remove mixer from update list
const idx = mixers.indexOf(enemy.mixer);
if (idx !== -1) mixers.splice(idx, 1);
scene.remove(enemy);
```
