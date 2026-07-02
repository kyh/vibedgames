import { Vector3 } from "three";
import { toVec3, VECTOR_EPS } from "../math/vector3-utils.js";
import { DEFAULT_WORLD_BASIS } from "../math/world-basis.js";

export const KINEMATIC_ACTOR_COLLISION_MODES = Object.freeze({
  // Resolve against static world only; queued actors do not block each other.
  ignoreActors: "ignoreActors",
  // Resolve all actors from their frame-start positions; movement order does not matter.
  startPositions: "startPositions",
  // Resolve actors one at a time; earlier moves can block later moves.
  sequential: "sequential",
});

const DEFAULT_ACTOR_COLLISION_MODE = KINEMATIC_ACTOR_COLLISION_MODES.startPositions;

function createColliderDesc(rapier, colliderShape, colliderOptions) {
  const type = colliderShape.type;

  let desc;
  if (type === "capsule") {
    desc = rapier.ColliderDesc.capsule(colliderShape.halfHeight, colliderShape.radius);
  } else if (type === "cuboid" || type === "box") {
    desc = rapier.ColliderDesc.cuboid(
      colliderShape.halfX,
      colliderShape.halfY,
      colliderShape.halfZ,
    );
  } else if (type === "ball" || type === "sphere") {
    desc = rapier.ColliderDesc.ball(colliderShape.radius);
  } else {
    throw new Error(`KinematicBatchResolver: unsupported shape type "${type}"`);
  }

  desc.setFriction(colliderOptions.friction ?? 0);
  desc.setRestitution(colliderOptions.restitution ?? 0);
  if (typeof colliderOptions.collisionGroups === "number") {
    desc.setCollisionGroups(colliderOptions.collisionGroups);
  }
  if (typeof colliderOptions.solverGroups === "number") {
    desc.setSolverGroups(colliderOptions.solverGroups);
  }
  if (typeof colliderOptions.sensor === "boolean") {
    desc.setSensor(colliderOptions.sensor);
  }
  return desc;
}

function configureCharacterController(characterController, controllerOptions, basisUp) {
  const up = controllerOptions.up ?? basisUp;
  characterController.setUp(up);

  if (controllerOptions.autostep?.enabled) {
    characterController.enableAutostep(
      controllerOptions.autostep.maxHeight,
      controllerOptions.autostep.minWidth,
      Boolean(controllerOptions.autostep.includeDynamicBodies),
    );
  } else {
    characterController.disableAutostep();
  }

  const snapToGround = controllerOptions.snapToGround;
  if (typeof snapToGround === "number" && snapToGround > 0) {
    characterController.enableSnapToGround(snapToGround);
  } else {
    characterController.disableSnapToGround();
  }

  if (typeof controllerOptions.maxSlopeClimbAngle === "number") {
    characterController.setMaxSlopeClimbAngle(controllerOptions.maxSlopeClimbAngle);
  }
  if (typeof controllerOptions.minSlopeSlideAngle === "number") {
    characterController.setMinSlopeSlideAngle(controllerOptions.minSlopeSlideAngle);
  }
  if (typeof controllerOptions.applyImpulses === "boolean") {
    characterController.setApplyImpulsesToDynamicBodies(controllerOptions.applyImpulses);
  }
  if (typeof controllerOptions.characterMass === "number") {
    characterController.setCharacterMass(controllerOptions.characterMass);
  }
  if (typeof controllerOptions.slide === "boolean") {
    characterController.setSlideEnabled(controllerOptions.slide);
  }
  if (typeof controllerOptions.normalNudgeFactor === "number") {
    characterController.setNormalNudgeFactor(controllerOptions.normalNudgeFactor);
  }
}

export class KinematicBatchResolver {
  constructor(
    world,
    rapier,
    minDeltaSeconds = 1 / 240,
    actorCollisionMode = DEFAULT_ACTOR_COLLISION_MODE,
    basis = DEFAULT_WORLD_BASIS,
  ) {
    if (!world || !rapier) {
      throw new Error("KinematicBatchResolver: world and rapier are required");
    }

    this.world = world;
    this.rapier = rapier;
    this.actorCollisionMode = actorCollisionMode;
    this.basis = basis;
    this.minDeltaSeconds = minDeltaSeconds;
    this.worldConfig = {
      basis: this.basis,
      minDeltaSeconds: this.minDeltaSeconds,
    };

    this.actors = new Set();
    this.actorColliderHandles = new Set();
    this.queuedMoves = [];
    this.results = new Map();
  }

  setActorCollisionMode(mode) {
    this.actorCollisionMode = mode;
  }

  createActor({
    position = null,
    bodyOffset = null,
    actorCollisionMode = null,
    groundedProbeDistance = 0,
    colliderShape,
    colliderOptions = {},
    controllerOptions = {},
    basis = this.basis,
  }) {
    const gameplayPosition = toVec3(position);
    const physicsBodyOffset = toVec3(bodyOffset);
    // Public actor position is the gameplay anchor; Rapier body position may be offset to collider center.
    const bodyPosition = gameplayPosition.clone().add(physicsBodyOffset);

    const characterController = this.world.createCharacterController(
      controllerOptions.offset ?? 0.02,
    );
    const basisUp = basis.upVector();
    configureCharacterController(characterController, controllerOptions, basisUp);

    const rigidBody = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        bodyPosition.x,
        bodyPosition.y,
        bodyPosition.z,
      ),
    );

    const colliderDesc = createColliderDesc(this.rapier, colliderShape, colliderOptions);
    const collider = this.world.createCollider(colliderDesc, rigidBody);

    const actor = {
      characterController,
      rigidBody,
      collider,
      physicsBodyOffset,
      basis,
      up: toVec3(controllerOptions.up ?? basisUp, basisUp),
      groundedProbeDistance,
      actorCollisionMode,
    };

    this.actors.add(actor);
    this.actorColliderHandles.add(collider.handle);
    this.world.updateSceneQueries();

    return actor;
  }

  beginFrame() {
    this.queuedMoves.length = 0;
    this.results.clear();
  }

  syncActor(actor, position) {
    if (!actor || !position) return;
    const bodyPosition = toVec3(position).add(actor.physicsBodyOffset);
    actor.rigidBody.setTranslation(bodyPosition, true);
    actor.rigidBody.setNextKinematicTranslation(bodyPosition);
  }

  queueMove(actor, movement = {}) {
    if (!actor || !this.actors.has(actor)) {
      throw new Error("KinematicBatchResolver: unknown actor handle");
    }

    this.queuedMoves.push({
      actor,
      startPosition: toVec3(movement.startPosition),
      desiredDelta: toVec3(movement.desiredDelta),
      deltaSeconds: movement.deltaSeconds,
    });
  }

  resolveQueuedMoves(deltaSeconds = 1 / 60, actorCollisionMode = this.actorCollisionMode) {
    const mode = actorCollisionMode;
    this.results.clear();

    if (mode === KINEMATIC_ACTOR_COLLISION_MODES.sequential) {
      for (const move of this.queuedMoves) {
        this.syncActor(move.actor, move.startPosition);
        this.world.updateSceneQueries();
        this.results.set(move.actor, this._resolveMove(move, undefined, true, deltaSeconds));
      }
      this.queuedMoves.length = 0;
      this._stepWorld(deltaSeconds);
      return this.results;
    }

    for (const move of this.queuedMoves) {
      this.syncActor(move.actor, move.startPosition);
    }
    this.world.updateSceneQueries();

    for (const move of this.queuedMoves) {
      const moveMode = move.actor.actorCollisionMode ?? mode;
      const predicate =
        moveMode === KINEMATIC_ACTOR_COLLISION_MODES.ignoreActors
          ? (collider) => !this.actorColliderHandles.has(collider.handle)
          : undefined;
      this.results.set(move.actor, this._resolveMove(move, predicate, false, deltaSeconds));
    }

    this.queuedMoves.length = 0;
    this._stepWorld(deltaSeconds);
    return this.results;
  }

  getResult(actor) {
    return this.results.get(actor) ?? null;
  }

  _resolveMove(move, filterPredicate, commitCurrentTranslation, fallbackDeltaSeconds) {
    const { actor, startPosition, desiredDelta } = move;
    const deltaSeconds = move.deltaSeconds ?? fallbackDeltaSeconds;

    actor.characterController.computeColliderMovement(
      actor.collider,
      desiredDelta,
      undefined,
      undefined,
      filterPredicate,
    );

    const rawCorrected = actor.characterController.computedMovement();
    const correctedDelta = new Vector3(rawCorrected.x, rawCorrected.y, rawCorrected.z);
    const bodyPosition = actor.rigidBody.translation();
    const nextBodyPosition = {
      x: bodyPosition.x + correctedDelta.x,
      y: bodyPosition.y + correctedDelta.y,
      z: bodyPosition.z + correctedDelta.z,
    };

    if (commitCurrentTranslation) {
      actor.rigidBody.setTranslation(nextBodyPosition, true);
    }
    actor.rigidBody.setNextKinematicTranslation(nextBodyPosition);

    const position = new Vector3(
      nextBodyPosition.x - actor.physicsBodyOffset.x,
      nextBodyPosition.y - actor.physicsBodyOffset.y,
      nextBodyPosition.z - actor.physicsBodyOffset.z,
    );
    const velocity =
      deltaSeconds > VECTOR_EPS
        ? correctedDelta.clone().multiplyScalar(1 / deltaSeconds)
        : new Vector3();

    const collisions = actor.characterController.numComputedCollisions();
    const grounded = actor.characterController.computedGrounded() || this._queryGrounded(actor);

    return {
      position,
      velocity,
      correctedDelta,
      grounded,
      blocked: collisions > 0,
      collisions,
      desiredDelta: desiredDelta.clone(),
      startPosition: startPosition.clone(),
    };
  }

  _queryGrounded(actor) {
    const probeDistance = Math.max(0, actor.groundedProbeDistance);
    if (probeDistance <= 0 || typeof this.world.castShape !== "function") return false;

    const down = actor.up.clone().multiplyScalar(-1);
    const hit = this.world.castShape(
      actor.collider.translation(),
      actor.collider.rotation(),
      down,
      actor.collider.shape,
      0,
      probeDistance,
      true,
      undefined,
      undefined,
      actor.collider,
      actor.rigidBody,
    );
    return Boolean(hit);
  }

  _stepWorld(deltaSeconds) {
    if (deltaSeconds <= 0) return;

    this.world.timestep = Math.max(this.worldConfig.minDeltaSeconds, deltaSeconds);
    this.world.step();
    this.world.updateSceneQueries();
  }
}
