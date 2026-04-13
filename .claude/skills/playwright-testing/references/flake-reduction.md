# Flake Reduction (Frontend)

## First: Classify the Flake

Before fixing, identify the category:

| Type | Symptom | Root Cause |
|------|---------|------------|
| **Readiness** | "Element not found", "Cannot read property of undefined" | App not ready when test interacts |
| **Timing** | Passes locally, fails in CI; intermittent | Animation/transition timing varies |
| **Environment** | Fails on specific CI runners | Viewport/DPR/fonts/GPU differences |
| **Data** | Fails after other tests run | Shared state, leftover data |
| **Concurrency** | Fails when tests run in parallel | Port conflicts, shared storage |

## Triage Workflow

1. **Reproduce locally** with CI-identical flags:
   ```bash
   # Match CI environment
   HEADLESS=true VIEWPORT=1280x720 npm test
   ```

2. **Capture evidence on failure:**
   - Console messages (via `browser_console_messages`)
   - Network requests with status codes
   - Screenshot at failure moment
   - State dump from `window.__TEST__.state()`

3. **Check for patterns:**
   - Always fails on first run? → Readiness flake
   - Fails only in parallel? → Concurrency flake
   - Fails on specific machine? → Environment flake

## Fix Patterns (In Order of Leverage)

### 1. Readiness Fixes (Most Common)

**Problem:** Test acts before app is ready.

**Solutions:**

Add explicit ready signal:
```javascript
// In app
window.__TEST__ = { ready: false };
// After initialization complete
window.__TEST__.ready = true;
```

Wait on ready signal:
```javascript
// In test via browser_evaluate
() => window.__TEST__?.ready === true
```

Avoid `waitForTimeout`—prefer `waitForFunction`:
```javascript
// Bad
await page.waitForTimeout(2000);

// Good
await page.waitForFunction(() => window.__TEST__.ready);
```

### 2. Determinism Fixes

**Problem:** RNG/time/animation causes different outcomes.

**Solutions:**

Seed RNG:
```javascript
// Deterministic random
function seededRandom(seed) {
  return function() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}
Math.random = seededRandom(12345);
```

Control time:
```javascript
// Fixed timestep for game loop
const FIXED_DT = 1000 / 60;
function gameLoop() {
  update(FIXED_DT); // Always same dt
  render();
  requestAnimationFrame(gameLoop);
}
```

Disable animations in test mode:
```javascript
if (window.__TEST__) {
  CSS.supports('animation', 'none') &&
    document.body.classList.add('no-animations');
}
```

### 3. Isolation Fixes

**Problem:** Tests affect each other.

**Solutions:**

Reset storage between tests:
```javascript
// Before each test
localStorage.clear();
sessionStorage.clear();
indexedDB.deleteDatabase('myapp');
```

Use unique test data:
```javascript
// Bad: shared account
const user = { email: 'test@example.com' };

// Good: unique per test
const user = { email: `test-${Date.now()}@example.com` };
```

Avoid order-dependent tests:
```javascript
// Each test should work standalone
// Don't rely on previous test creating data
```

### 4. Environment Fixes

**Problem:** Different machines produce different results.

**Solutions:**

Lock viewport and DPR:
```javascript
// In test setup
await page.setViewportSize({ width: 1280, height: 720 });
await page.emulateMedia({ colorScheme: 'light' });
```

Lock locale/timezone:
```javascript
// Via browser context
const context = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'America/New_York'
});
```

Handle font differences:
```javascript
// Either: use system fonts only
// Or: preload and wait for web fonts
await document.fonts.ready;
```

### 5. Temporary Guardrails

**Use retries ONLY as temporary measure:**
```javascript
// Tag flaky tests for tracking
test.describe('flaky-wip', () => {
  test.retry(2); // Temporary until fixed

  test('intermittent test', async () => {
    // TODO: Fix readiness issue in #123
  });
});
```

**Track flaky tests:**
- Create ticket for each flaky test
- Set deadline for fix
- Remove retry once fixed

## Flake Diagnosis Checklist

When a test fails:

- [ ] What exact error message?
- [ ] Does it reproduce locally with same config?
- [ ] What was the app state at failure? (screenshot/state dump)
- [ ] Were there console errors?
- [ ] Were there failed network requests?
- [ ] Did other tests run before this one?
- [ ] Is there shared state being modified?
- [ ] Does it pass with increased timeouts? (readiness issue)
- [ ] Does it pass when run alone? (concurrency issue)

## Red Flags in Test Code

```javascript
// Red flag: magic sleep
await page.waitForTimeout(3000);
// Fix: wait for specific condition

// Red flag: retry loop
for (let i = 0; i < 3; i++) {
  try { await test(); break; } catch {}
}
// Fix: make test deterministic

// Red flag: order-dependent
test('B depends on A', () => { /* uses data from test A */ });
// Fix: set up own data

// Red flag: time-sensitive assertion
expect(performance.now() - start).toBeLessThan(100);
// Fix: mock time or use range

// Red flag: DOM structure assertion
expect(wrapper.find('.btn-primary-v2')).toExist();
// Fix: assert on text/role/behavior
```
