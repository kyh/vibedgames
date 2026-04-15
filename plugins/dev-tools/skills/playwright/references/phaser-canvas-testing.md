# Phaser / Canvas / WebGL Testing

## Why Canvas/WebGL Tests Get Flaky

Common nondeterminism sources:
- Variable frame times (CPU load, headless rendering)
- Time-based movement/physics without fixed timestep
- RNG for loot/spawns/AI decisions
- Async asset loading and "first frame" races
- Font loading differences affecting mixed DOM+canvas layouts
- GPU/driver differences in rendering

**The fix is not "more retries"—it's deterministic mode + explicit readiness.**

## Deterministic Mode Pattern

When `?test=1` query param (or build-time flag) is enabled:

```javascript
// In game initialization
const isTestMode = new URLSearchParams(window.location.search).has('test');

if (isTestMode) {
  // 1. Seed RNG
  const seed = parseInt(params.get('seed')) || 12345;
  Math.random = seededRandom(seed);

  // 2. Fixed timestep
  game.loop.targetFps = 60;
  game.loop.forceSetTimeOut = true; // Consistent frame timing

  // 3. Disable visual noise
  disableCameraShake();
  disableParticles();
  disableScreenFlash();

  // 4. Ensure assets preloaded before interaction
  await preloadAllAssets();
}
```

## Implementing the Test Seam

```javascript
// Add to your game's boot or create phase
window.__TEST__ = {
  ready: false,
  seed: null,
  sceneKey: null,
  frameCount: 0,

  state: () => ({
    scene: game.scene.getScenes(true)[0]?.scene.key,
    player: getPlayerState(),
    enemies: getEnemyStates(),
    score: gameState.score,
    resources: gameState.resources
  }),

  commands: {
    reset: () => game.scene.start('MainMenu'),
    seed: (n) => { seedRNG(n); window.__TEST__.seed = n; },
    skipIntro: () => game.scene.start('Gameplay'),
    advanceFrame: () => game.loop.step(16.67)
  }
};

// Set ready after:
// 1. Preload completed
// 2. First scene created
// 3. First render tick occurred
game.events.on('ready', () => {
  window.__TEST__.ready = true;
});
```

## What to Assert (Avoid Brittle Assertions)

**Good assertions** (match player-visible behavior):
- "Player can start" → scene key is correct, UI state is interactive
- "Attack damages enemy" → enemy HP decreased after attack action
- "Collecting coin increments score" → score increased by expected amount
- "Player dies at 0 HP" → death state triggered, game over UI shown

**Brittle assertions to avoid:**
- Exact pixel positions without fixed dt and RNG
- Internal array/map ordering
- Sprite instance properties directly
- Animation frame indices

## Screenshot Testing: Making It Reliable

Before comparing screenshots:

1. **Lock viewport + DPR:**
   ```
   mcp__playwright__browser_resize({ width: 1280, height: 720 })
   ```

2. **Set deterministic mode:**
   ```
   Navigate to: http://localhost:3000?test=1&seed=42
   ```

3. **Wait for stable frame:**
   ```javascript
   // Via browser_evaluate
   () => window.__TEST__.ready && window.__TEST__.frameCount >= 10
   ```

4. **Target screenshots strategically:**
   - Menu screens (static, predictable)
   - First gameplay frame after deterministic setup
   - Specific game states (pause menu, game over)

  NOT every frame or random gameplay moments.

## UI Slicing Regressions (Nine-Slice / Ribbons / Bars)

For visual bugs in UI panels, ribbons, or HUD bars, stop relying on the full game flow—use a dedicated UI harness scene.

### Harness Pattern
1. Load only the UI assets (papers, ribbons, bars) into `test.html`.
2. Present each element twice: raw frame/tile views and final assembled render at different sizes.
3. Add keyboard controls (`1..N`) plus `window.__TEST__.commands.showTest(n)` so Playwright can flip modes.
4. Capture targeted screenshots (panels, ribbons, bars) deterministically; diff them in CI with `scripts/imgdiff.py`.

This makes nine-slice/trimming issues and segmented ribbons easy to spot without the noise of gameplay.

See the UI harness instructions in the main skill and `docs/postmortem-ui-panel-rendering.md` for reference.

## Phaser-Specific Patterns

### Fixed Timestep for Physics

```javascript
const config = {
  physics: {
    default: 'arcade',
    arcade: {
      // Fixed timestep for deterministic physics
      fps: 60,
      timeScale: 1
    }
  }
};
```

### Seeding Phaser's RNG

```javascript
// Phaser has built-in seeded random
const rnd = new Phaser.Math.RandomDataGenerator([seed.toString()]);
// Use rnd.frac(), rnd.between(), etc. instead of Math.random()
```

### Waiting for Asset Load

```javascript
// In preload scene
this.load.on('complete', () => {
  window.__TEST__.assetsLoaded = true;
});
```

### Exposing Entity State Safely

```javascript
// Don't expose: this.player (Sprite instance)
// Do expose:
window.__TEST__.state = () => ({
  player: {
    x: Math.round(this.player.x),
    y: Math.round(this.player.y),
    hp: this.player.getData('hp'),
    state: this.player.getData('state')
  }
});
```

## Test Workflow for Phaser Games

1. **Navigate** with `?test=1&seed=<number>`
2. **Wait** for `window.__TEST__.ready === true`
3. **Drive input** via `browser_press_key` for WASD/arrows, `browser_click` for UI
4. **Wait** for game state change (poll `window.__TEST__.state()`)
5. **Assert** state matches expected outcome
6. **Screenshot** at known deterministic points only
