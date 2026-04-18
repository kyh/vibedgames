# Playwright MCP Cheatsheet

Patterns for using Playwright MCP tools during frontend testing tasks (especially canvas/WebGL games).

## Mental Model

- Use MCP to reproduce a user flow and collect evidence: console, network, screenshots, and state
- Prefer explicit readiness over time-based waits
- Treat *any* console error (or failed asset request) as a product failure unless explicitly allowed

## Tool Patterns by Task

### Navigate + Wait for App Readiness

**For DOM apps:**
```
1. mcp__playwright__browser_navigate({ url: "http://localhost:3000" })
2. mcp__playwright__browser_wait_for({ text: "Welcome" })
```

**For canvas/game apps:**
```
1. mcp__playwright__browser_navigate({ url: "http://localhost:3000?test=1" })
2. mcp__playwright__browser_evaluate({
     function: "() => new Promise(resolve => { const check = () => window.__TEST__?.ready ? resolve(true) : setTimeout(check, 100); check(); })"
   })
```

### Assert State (White-Box via Test Seams)

Read app state through exposed test API:

```
mcp__playwright__browser_evaluate({
  function: "() => window.__TEST__.state()"
})
```

Common assertions:
- Scene/route: `window.__TEST__.sceneKey === "MainMenu"`
- Score/resources: `window.__TEST__.state().score >= 100`
- Entity state: `window.__TEST__.state().player.hp > 0`

### Drive User Input

**Click interactions:**
```
mcp__playwright__browser_click({ element: "Start Button", ref: "[ref-from-snapshot]" })
```

**Keyboard input (games):**
```
mcp__playwright__browser_press_key({ key: "ArrowRight" })
mcp__playwright__browser_press_key({ key: "Space" })  // attack/jump
```

**Drag operations:**
```
mcp__playwright__browser_drag({
  startElement: "Tower icon", startRef: "[ref]",
  endElement: "Map tile", endRef: "[ref]"
})
```

**Text input:**
```
mcp__playwright__browser_type({
  element: "Player name field",
  ref: "[ref]",
  text: "TestPlayer"
})
```

### Catch Silent Failures

**Check for console errors:**
```
mcp__playwright__browser_console_messages({ level: "error" })
// Fail test if any errors returned
```

**Check for failed network requests:**
```
mcp__playwright__browser_network_requests()
// Fail if any required asset returned non-2xx/3xx
```

### Visual Evidence

**Take screenshot (after determinism enforced):**
```
mcp__playwright__browser_take_screenshot({
  filename: "game-main-menu.png",
  type: "png"
})
```

**Element screenshot:**
```
mcp__playwright__browser_take_screenshot({
  element: "Game canvas",
  ref: "[ref]",
  filename: "canvas-state.png"
})
```

## Workflow: Complete Test Sequence

1. **Navigate** to app URL (with `?test=1` for deterministic mode)
2. **Wait** for readiness signal
3. **Check** console for pre-existing errors
4. **Drive** user input sequence
5. **Assert** state via test seams
6. **Screenshot** if visual verification needed
7. **Check** console/network for errors introduced by actions

## Test Seam Recommendations

Minimal, stable, read-only seams to add to the app:

```javascript
window.__TEST__ = {
  ready: false,           // Set true after first interactive frame
  version: "1.0.0",       // For cache invalidation
  seed: null,             // Current RNG seed (if seeded)
  sceneKey: null,         // Current scene/route
  state: () => ({         // Returns JSON-serializable snapshot
    scene: this.sceneKey,
    player: { x, y, hp, state },
    score: currentScore,
    entities: [...entityList.map(e => ({ id, type, x, y }))]
  }),
  commands: {             // Optional mutation commands
    reset: () => {},      // Reset to initial state
    seed: (n) => {},      // Set RNG seed
    skipIntro: () => {},  // Jump past animations
    setTime: (t) => {}    // Control game clock
  }
};
```

**Key principle**: Expose IDs + essential fields, not raw engine objects.

## Common Gotchas

1. **Race on navigate**: Always wait for readiness after navigation, never assume immediate availability
2. **Stale refs**: Snapshot refs become invalid after navigation or major DOM changes—re-snapshot
3. **Animation timing**: Screenshots during animations will be inconsistent—wait for animation completion or disable animations
4. **Canvas click coordinates**: For canvas, clicking via MCP clicks DOM position—ensure canvas fills expected area
