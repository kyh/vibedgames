# Physics for Three.js Games

Pick the lightest tool that gives the feel you want. Realism is rarely the goal — _responsiveness and predictability_ are.

## Selection

| Need                                                                | Use                                 |
| ------------------------------------------------------------------- | ----------------------------------- |
| Pickups, triggers, "did A overlap B?", hand-tuned jump              | **Arcade / custom** — no dependency |
| A few dozen dynamic rigid bodies, pure-JS, simple setup             | **cannon-es**                       |
| Stable stacking, many bodies, raycasts, a real character controller | **Rapier**                          |

Mixing is fine and common: Rapier for the world, arcade overlap for collectible coins.

---

## Arcade / custom (no dependency)

For triggers and pickups, an overlap test beats a simulation. Sphere-sphere is cheapest and good enough for most gameplay:

```javascript
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

function overlaps(objA, radiusA, objB, radiusB) {
  objA.getWorldPosition(_a);
  objB.getWorldPosition(_b);
  const r = radiusA + radiusB;
  return _a.distanceToSquared(_b) <= r * r; // squared: no sqrt
}

// In fixedUpdate:
for (let i = coins.active.length - 1; i >= 0; i--) {
  const coin = coins.active[i];
  if (overlaps(player, 0.5, coin, 0.4)) {
    collect(coin);
    coins.despawn(coin); // see game-patterns.md ObjectPool
  }
}
```

Hand-authored gravity for a platformer you want to _feel_ a specific way (tune with `game-feel`):

```javascript
const GRAVITY = -30; // not -9.81 — game gravity is usually punchier than real
const JUMP_V = 11;
let vy = 0,
  grounded = false;

function updatePlatformer(dt) {
  if (intent.jump && grounded) {
    vy = JUMP_V;
    grounded = false;
  }
  vy += GRAVITY * dt;
  player.position.y += vy * dt;
  if (player.position.y <= 0) {
    player.position.y = 0;
    vy = 0;
    grounded = true;
  }
}
```

---

## cannon-es

Pure-JS rigid bodies. Create a body per mesh, step the world, copy transforms back. (Minimal falling-sphere example is in [`advanced-topics.md`](advanced-topics.md); here's the reusable sync pattern for many bodies.)

```javascript
import * as CANNON from "https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js";

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
const pairs = []; // { mesh, body }

function addBox(mesh, halfExtents, mass = 1) {
  const body = new CANNON.Body({
    mass,
    shape: new CANNON.Box(new CANNON.Vec3(...halfExtents)),
    position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z),
  });
  world.addBody(body);
  pairs.push({ mesh, body });
  return body;
}

function stepPhysics(dt) {
  world.step(1 / 60, dt, 3); // fixed step, remaining dt, max substeps
  for (const { mesh, body } of pairs) {
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
  }
}
```

`cannon-es` `Vec3`/`Quaternion` are shape-compatible with three's `.copy()`, so the sync is one line each.

---

## Rapier (default for serious games)

`@dimforge/rapier3d-compat` is WASM, so it must be initialized once before use.

```javascript
import RAPIER from "https://esm.sh/@dimforge/rapier3d-compat";

await RAPIER.init(); // REQUIRED before any RAPIER.* constructor
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
```

### Rigid body + collider + sync

```javascript
const bodies = []; // { mesh, body }

function addDynamicBox(mesh, half) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(
      mesh.position.x,
      mesh.position.y,
      mesh.position.z,
    ),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setRestitution(0.2),
    body,
  );
  bodies.push({ mesh, body });
  return body;
}

// static ground
world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50));

function stepPhysics() {
  world.step(); // uses the world's own fixed timestep; call once per fixedUpdate
  for (const { mesh, body } of bodies) {
    const t = body.translation();
    const r = body.rotation();
    mesh.position.set(t.x, t.y, t.z);
    mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}
```

Set `world.timestep = 1 / 60` once if you want it to match your `STEP`; then call `world.step()` exactly once per `fixedUpdate`.

### Kinematic character controller

This is the main reason to choose Rapier for a 3D game — a controller that walks up steps and sticks to ground without you hand-rolling collision response. See [`controllers-and-camera.md`](controllers-and-camera.md) for the full movement build; the Rapier side:

```javascript
const controller = world.createCharacterController(0.01); // skin width
controller.enableAutostep(0.5, 0.2, true); // maxHeight, minWidth, dynamicBodies
controller.enableSnapToGround(0.5); // stick to slopes/stairs going down
controller.setApplyImpulsesToDynamicBodies(true); // push crates around

// each fixedUpdate, given a desired delta movement (THREE.Vector3):
controller.computeColliderMovement(playerCollider, {
  x: desired.x,
  y: desired.y,
  z: desired.z,
});
const m = controller.computedMovement();
playerBody.setNextKinematicTranslation({
  x: playerBody.translation().x + m.x,
  y: playerBody.translation().y + m.y,
  z: playerBody.translation().z + m.z,
});
const grounded = controller.computedGrounded();
```

The player body is `RigidBodyDesc.kinematicPositionBased()` with a `capsule` collider.

### Raycasts (ground checks, shooting, line-of-sight)

```javascript
const ray = new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 });
const hit = world.castRay(ray, 100, true); // maxToi, solid
if (hit) {
  const distance = hit.timeOfImpact;
  const point = ray.pointAt(distance);
}
```

### Cleanup

When you remove an entity, remove its body — colliders go with it:

```javascript
world.removeRigidBody(body);
const i = bodies.findIndex((p) => p.body === body);
if (i !== -1) bodies.splice(i, 1);
```

---

## Performance notes

- **One `world.step()` per fixed step**, never per render frame (see the loop in [`gameplay-systems.md`](gameplay-systems.md)).
- **Reuse scratch vectors** (`const _v = new THREE.Vector3()` at module scope) — never allocate in the step.
- **Sleep static-heavy scenes** — Rapier auto-sleeps idle bodies; don't wake them by writing transforms every frame.
- **Collider count, not mesh count, drives physics cost.** Use compound/simplified colliders for detailed models — a capsule or box, not the GLB's full mesh, unless you need precise collision.
