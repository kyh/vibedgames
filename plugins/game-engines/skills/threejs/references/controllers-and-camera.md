# Controllers & Camera

Responsive movement and a camera that always shows the next decision are most of 3D game feel. Tune the numbers here with the `game-feel` skill.

> **Copy the controller, generate the camera:** `modules/character-movement.ts` ships a grounded `CharacterController` + Y-up frame helpers, and `modules/kinematic-resolver.ts` wraps Rapier character collision — copy those rather than re-deriving them (see `modules/summary.md`). Camera rigs and input schemes are game-specific; build them live from this guide.

## Input → intent

The controller never reads the keyboard. `input.js` translates raw events into an `intent` object; the controller consumes it. This lets touch controls (`gamepad` skill) and AI feed the same controller, and makes movement testable.

```javascript
// core/input.js
export const intent = { moveX: 0, moveZ: 0, jump: false, jumpHeld: false };
const keys = new Set();

addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));

export function updateInput() {
  intent.moveX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  intent.moveZ = (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0);
  const jumpDown = keys.has("Space");
  intent.jump = jumpDown && !intent.jumpHeld; // edge: true only on the frame pressed
  intent.jumpHeld = jumpDown;
}
```

`intent.jump` as an _edge_ (true once per press) is what lets you add jump buffering / coyote time later — see `game-feel`.

---

## Transform-based controller (no physics engine)

For arcade movement where you want exact authored feel. Movement is camera-relative so "forward" means "away from camera," which is what players expect.

```javascript
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const SPEED = 6;

function updateController(dt) {
  // camera-relative basis, flattened to the ground plane
  camera.getWorldDirection(_forward);
  _forward.y = 0;
  _forward.normalize();
  _right.crossVectors(_forward, camera.up).normalize();

  _move.set(0, 0, 0).addScaledVector(_right, intent.moveX).addScaledVector(_forward, -intent.moveZ);
  if (_move.lengthSq() > 1) _move.normalize(); // no diagonal speed boost

  player.position.addScaledVector(_move, SPEED * dt);

  // face movement direction (smoothed)
  if (_move.lengthSq() > 0.0001) {
    const targetYaw = Math.atan2(_move.x, _move.z);
    player.rotation.y = dampAngle(player.rotation.y, targetYaw, 0.001, dt);
  }
}
```

Diagonal normalization (`if lengthSq > 1`) matters — without it, holding two keys moves √2× faster. Players notice.

---

## Rapier kinematic character controller

Pairs with [`physics.md`](physics.md). Builds a per-step desired movement, then lets Rapier resolve it against the world (walls, stairs, slopes).

```javascript
const SPEED = 6,
  GRAVITY = -25,
  JUMP_V = 9;
let vy = 0;
const desired = new THREE.Vector3();

function updateKinematic(dt) {
  // horizontal from intent (camera-relative, as above)
  computeHorizontal(desired, SPEED * dt); // fills desired.x / desired.z

  const grounded = controller.computedGrounded();
  if (grounded && vy < 0) vy = 0;
  if (intent.jump && grounded) vy = JUMP_V;
  vy += GRAVITY * dt;
  desired.y = vy * dt;

  controller.computeColliderMovement(playerCollider, desired);
  const m = controller.computedMovement();
  const p = playerBody.translation();
  playerBody.setNextKinematicTranslation({
    x: p.x + m.x,
    y: p.y + m.y,
    z: p.z + m.z,
  });
}
```

Read `computedGrounded()` _before_ applying the next move — it reflects the previous step's resolution, which is what you want for the jump check.

---

## Follow / third-person camera

Frame-rate-independent smoothing is non-negotiable: a constant `lerp` factor makes the camera feel different on a 144Hz monitor than a 60Hz one.

```javascript
const camOffset = new THREE.Vector3(0, 4, 8); // behind & above
const _targetPos = new THREE.Vector3();
const _lookAt = new THREE.Vector3();

// smoothing = fraction of distance REMAINING after 1s. 0.001 ≈ snappy, 0.2 ≈ floaty.
function updateCamera(dt, smoothing = 0.0015) {
  // desired position = player position + offset rotated by player yaw
  _targetPos
    .copy(camOffset)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), player.rotation.y)
    .add(player.position);

  const t = 1 - Math.pow(smoothing, dt); // frame-rate independent
  camera.position.lerp(_targetPos, t);

  // look slightly ahead/up so the player isn't centered on their own feet
  _lookAt.copy(player.position).add(new THREE.Vector3(0, 1.2, 0));
  camera.lookAt(_lookAt);
}
```

### Lookahead (show where you're going)

Bias the look target toward velocity so the camera reveals what's ahead in the direction of travel — the single biggest readability win for fast games:

```javascript
_lookAt
  .copy(player.position)
  .add(new THREE.Vector3(0, 1.2, 0))
  .addScaledVector(playerVelocity, 0.25); // 0.25s of lead
```

### Camera collision (don't clip through walls)

Clamp the **desired** position (`_targetPos`), not the already-lerped `camera.position` — the ray must cover the full player→target segment, then you smooth toward the clamped point. Clamping after the lerp rays along a shorter segment and can miss a wall the camera is sliding into.

```javascript
const _dir = new THREE.Vector3();
// mutates `desired` in place; call BEFORE the lerp
function clampToWalls(desired) {
  _dir.subVectors(desired, player.position);
  const dist = _dir.length();
  if (dist < 1e-4) return;
  _dir.divideScalar(dist); // normalize
  raycaster.set(player.position, _dir);
  const hit = raycaster.intersectObjects(walls, true)[0];
  if (hit && hit.distance < dist) {
    desired.copy(player.position).addScaledVector(_dir, hit.distance * 0.9);
  }
}
```

Wire it into `updateCamera`, right after `_targetPos` is computed and before the lerp:

```javascript
clampToWalls(_targetPos); // pull the target in if a wall is between player and camera
camera.position.lerp(_targetPos, t);
```

---

## Helpers

Frame-rate-independent angle damping. `player.rotation.y` accumulates without bound, so take the _shortest_ signed turn to the target — `atan2(sin, cos)` always returns it in `(-π, π]` regardless of how large either angle has grown:

```javascript
function dampAngle(current, target, smoothing, dt) {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + diff * (1 - Math.pow(smoothing, dt));
}
```

## Tuning starting points

| Feel               | SPEED | GRAVITY | JUMP_V | cam smoothing |
| ------------------ | ----- | ------- | ------ | ------------- |
| Snappy arcade      | 8–10  | −30     | 11     | 0.0005        |
| Grounded/realistic | 4–6   | −20     | 8      | 0.005         |
| Floaty/space       | 3–5   | −8      | 6      | 0.05          |

These are starting points — open them in `lil-gui` and feel them. See `game-feel` for coyote time, jump buffering, and input forgiveness windows.
