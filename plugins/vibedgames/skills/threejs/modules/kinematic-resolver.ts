import { Vector3 } from "three";
import type RAPIER from "@dimforge/rapier3d-compat";

const EPS = 1e-6;
const UP: RAPIER.Vector = { x: 0, y: 1, z: 0 };

export type ActorCollisionMode = "ignore-actors" | "start-positions" | "sequential";

export type ColliderGeometry =
  | { type: "capsule"; halfHeight: number; radius: number }
  | { type: "cuboid"; halfX: number; halfY: number; halfZ: number }
  | { type: "ball"; radius: number };

export interface ColliderOptions {
  friction?: number;
  restitution?: number;
  collisionGroups?: number;
  solverGroups?: number;
  sensor?: boolean;
}

export interface ControllerOptions {
  /** Collision skin width. */
  offset?: number;
  autostep?: { maxHeight: number; minWidth: number; includeDynamicBodies?: boolean };
  /** Distance to snap down to ground when going over the crest of a slope/stair. */
  snapToGround?: number;
  maxSlopeClimbAngle?: number;
  minSlopeSlideAngle?: number;
  applyImpulsesToDynamicBodies?: boolean;
  characterMass?: number;
  slide?: boolean;
}

export interface CreateActorOptions {
  position?: Vector3;
  /** Offset from the gameplay anchor to the Rapier body/collider center. */
  bodyOffset?: Vector3;
  colliderGeometry: ColliderGeometry;
  colliderOptions?: ColliderOptions;
  controllerOptions?: ControllerOptions;
  /**
   * Force this actor to ignore other actors' colliders (collide with static world
   * only), regardless of the batch mode. Ordering/commit behavior is always a
   * whole-batch property (the `mode` argument to resolveQueuedMoves), never per-actor.
   */
  ignoreActors?: boolean;
  /** Extra downward shapecast distance to still count as grounded (0 = disabled). */
  groundedProbeDistance?: number;
}

export interface Actor {
  readonly characterController: RAPIER.KinematicCharacterController;
  readonly rigidBody: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly bodyOffset: Vector3;
  readonly groundedProbeDistance: number;
  readonly ignoreActors: boolean | null;
}

export interface MoveRequest {
  startPosition: Vector3;
  desiredDelta: Vector3;
  deltaSeconds?: number;
}

export interface MoveResult {
  position: Vector3;
  velocity: Vector3;
  correctedDelta: Vector3;
  grounded: boolean;
  blocked: boolean;
  collisions: number;
}

interface QueuedMove {
  actor: Actor;
  startPosition: Vector3;
  desiredDelta: Vector3;
  deltaSeconds?: number;
}

const toVec3 = (value?: Vector3) => (value ? value.clone() : new Vector3());

const createColliderDesc = (
  rapier: typeof RAPIER,
  geometry: ColliderGeometry,
  options: ColliderOptions,
) => {
  let desc: RAPIER.ColliderDesc;

  if (geometry.type === "capsule") {
    desc = rapier.ColliderDesc.capsule(geometry.halfHeight, geometry.radius);
  } else if (geometry.type === "cuboid") {
    desc = rapier.ColliderDesc.cuboid(geometry.halfX, geometry.halfY, geometry.halfZ);
  } else {
    desc = rapier.ColliderDesc.ball(geometry.radius);
  }

  desc.setFriction(options.friction ?? 0);
  desc.setRestitution(options.restitution ?? 0);

  if (options.collisionGroups !== undefined) {
    desc.setCollisionGroups(options.collisionGroups);
  }

  if (options.solverGroups !== undefined) {
    desc.setSolverGroups(options.solverGroups);
  }

  if (options.sensor !== undefined) {
    desc.setSensor(options.sensor);
  }

  return desc;
};

const configureController = (
  controller: RAPIER.KinematicCharacterController,
  options: ControllerOptions,
) => {
  controller.setUp(UP);

  if (options.autostep) {
    controller.enableAutostep(
      options.autostep.maxHeight,
      options.autostep.minWidth,
      Boolean(options.autostep.includeDynamicBodies),
    );
  } else {
    controller.disableAutostep();
  }

  if (options.snapToGround !== undefined && options.snapToGround > 0) {
    controller.enableSnapToGround(options.snapToGround);
  } else {
    controller.disableSnapToGround();
  }

  if (options.maxSlopeClimbAngle !== undefined) {
    controller.setMaxSlopeClimbAngle(options.maxSlopeClimbAngle);
  }

  if (options.minSlopeSlideAngle !== undefined) {
    controller.setMinSlopeSlideAngle(options.minSlopeSlideAngle);
  }

  if (options.applyImpulsesToDynamicBodies !== undefined) {
    controller.setApplyImpulsesToDynamicBodies(options.applyImpulsesToDynamicBodies);
  }

  if (options.characterMass !== undefined) {
    controller.setCharacterMass(options.characterMass);
  }

  if (options.slide !== undefined) {
    controller.setSlideEnabled(options.slide);
  }
};

export class KinematicResolver {
  private readonly actorColliderHandles = new Set<number>();
  private readonly queuedMoves: QueuedMove[] = [];
  private readonly results = new Map<Actor, MoveResult>();
  private readonly world: RAPIER.World;
  private readonly rapier: typeof RAPIER;
  private readonly defaultMode: ActorCollisionMode;
  private readonly minStepSeconds: number;

  constructor(
    world: RAPIER.World,
    rapier: typeof RAPIER,
    defaultMode: ActorCollisionMode = "start-positions",
    minStepSeconds = 1 / 240,
  ) {
    this.world = world;
    this.rapier = rapier;
    this.defaultMode = defaultMode;
    this.minStepSeconds = minStepSeconds;
  }

  createActor(options: CreateActorOptions) {
    const anchor = toVec3(options.position);
    const bodyOffset = toVec3(options.bodyOffset);
    const bodyPosition = anchor.clone().add(bodyOffset);

    const characterController = this.world.createCharacterController(
      options.controllerOptions?.offset ?? 0.02,
    );

    configureController(characterController, options.controllerOptions ?? {});

    const rigidBody = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        bodyPosition.x,
        bodyPosition.y,
        bodyPosition.z,
      ),
    );

    const collider = this.world.createCollider(
      createColliderDesc(this.rapier, options.colliderGeometry, options.colliderOptions ?? {}),
      rigidBody,
    );

    const actor: Actor = {
      bodyOffset,
      characterController,
      collider,
      groundedProbeDistance: options.groundedProbeDistance ?? 0,
      ignoreActors: options.ignoreActors ?? null,
      rigidBody,
    };

    this.actorColliderHandles.add(collider.handle);
    this.world.propagateModifiedBodyPositionsToColliders();

    return actor;
  }

  /**
   * Remove an actor and free its Rapier body, collider, and character controller.
   * Call on despawn — otherwise handles leak and a reused collider handle can make
   * `ignore-actors` filtering treat a later, unrelated collider as an actor.
   */
  removeActor(actor: Actor) {
    this.actorColliderHandles.delete(actor.collider.handle);
    this.results.delete(actor);

    for (let i = this.queuedMoves.length - 1; i >= 0; i -= 1) {
      if (this.queuedMoves[i]?.actor === actor) {
        this.queuedMoves.splice(i, 1);
      }
    }

    this.world.removeCharacterController(actor.characterController);
    this.world.removeRigidBody(actor.rigidBody);
  }

  /** Clear last frame's queued moves and results. Call once per frame before queueing. */
  beginFrame() {
    this.queuedMoves.length = 0;
    this.results.clear();
  }

  /** Teleport an actor (e.g. respawn) without a collision sweep. */
  static syncActor(actor: Actor, position: Vector3) {
    const bodyPosition = position.clone().add(actor.bodyOffset);
    actor.rigidBody.setTranslation(bodyPosition, true);
    actor.rigidBody.setNextKinematicTranslation(bodyPosition);
  }

  queueMove(actor: Actor, move: MoveRequest) {
    this.queuedMoves.push({
      actor,
      deltaSeconds: move.deltaSeconds,
      desiredDelta: toVec3(move.desiredDelta),
      startPosition: toVec3(move.startPosition),
    });
  }

  resolveQueuedMoves(deltaSeconds = 1 / 60, mode: ActorCollisionMode = this.defaultMode) {
    this.results.clear();

    if (mode === "sequential") {
      for (const move of this.queuedMoves) {
        KinematicResolver.syncActor(move.actor, move.startPosition);
        this.world.propagateModifiedBodyPositionsToColliders();
        this.results.set(
          move.actor,
          this.resolveMove(move, this.actorFilter(move.actor, mode), true, deltaSeconds),
        );
      }
    } else {
      for (const move of this.queuedMoves) {
        KinematicResolver.syncActor(move.actor, move.startPosition);
      }

      this.world.propagateModifiedBodyPositionsToColliders();

      for (const move of this.queuedMoves) {
        this.results.set(
          move.actor,
          this.resolveMove(move, this.actorFilter(move.actor, mode), false, deltaSeconds),
        );
      }
    }

    this.queuedMoves.length = 0;
    this.stepWorld(deltaSeconds);

    return this.results;
  }

  getResult(actor: Actor) {
    return this.results.get(actor) ?? null;
  }

  private actorFilter(actor: Actor, mode: ActorCollisionMode) {
    const ignore = actor.ignoreActors ?? mode === "ignore-actors";

    return ignore
      ? (collider: RAPIER.Collider) => !this.actorColliderHandles.has(collider.handle)
      : undefined;
  }

  private resolveMove(
    move: QueuedMove,
    filter: ((collider: RAPIER.Collider) => boolean) | undefined,
    commitTranslation: boolean,
    fallbackDeltaSeconds: number,
  ) {
    const { actor, desiredDelta } = move;
    const deltaSeconds = move.deltaSeconds ?? fallbackDeltaSeconds;

    actor.characterController.computeColliderMovement(
      actor.collider,
      desiredDelta,
      undefined,
      undefined,
      filter,
    );
    const raw = actor.characterController.computedMovement();
    const correctedDelta = new Vector3(raw.x, raw.y, raw.z);

    const body = actor.rigidBody.translation();

    const nextBody = {
      x: body.x + correctedDelta.x,
      y: body.y + correctedDelta.y,
      z: body.z + correctedDelta.z,
    };

    if (commitTranslation) {
      actor.rigidBody.setTranslation(nextBody, true);
    }

    actor.rigidBody.setNextKinematicTranslation(nextBody);

    const position = new Vector3(
      nextBody.x - actor.bodyOffset.x,
      nextBody.y - actor.bodyOffset.y,
      nextBody.z - actor.bodyOffset.z,
    );

    const velocity =
      deltaSeconds > EPS ? correctedDelta.clone().multiplyScalar(1 / deltaSeconds) : new Vector3();

    const collisions = actor.characterController.numComputedCollisions();

    const grounded =
      actor.characterController.computedGrounded() || this.probeGrounded(actor, nextBody);

    return {
      blocked: collisions > 0,
      collisions,
      correctedDelta,
      grounded,
      position,
      velocity,
    };
  }

  private probeGrounded(actor: Actor, origin: RAPIER.Vector) {
    const distance = Math.max(0, actor.groundedProbeDistance);

    if (distance <= 0) {
      return false;
    }

    const hit = this.world.castShape(
      origin,
      actor.collider.rotation(),
      { x: 0, y: -1, z: 0 },
      actor.collider.shape,
      0,
      distance,
      true,
      undefined,
      undefined,
      actor.collider,
      actor.rigidBody,
    );

    return Boolean(hit);
  }

  private stepWorld(deltaSeconds: number) {
    if (deltaSeconds <= 0) {
      return;
    }

    this.world.timestep = Math.max(this.minStepSeconds, deltaSeconds);
    this.world.step();
    this.world.propagateModifiedBodyPositionsToColliders();
  }
}
