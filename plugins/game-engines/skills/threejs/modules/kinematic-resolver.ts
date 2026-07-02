// Resolves kinematic character movement through Rapier collision for many actors in
// one physics step, and reports per-actor grounded/collision outcomes. This wraps the
// fiddly parts of Rapier's KinematicCharacterController (collider offset, autostep,
// snap-to-ground, the grounded shapecast probe, kinematic translation) that are easy
// to wire up wrong. World is Y-up. Approach inspired by GameBlocks
// (https://github.com/xt4d/GameBlocks).
//
// Pass the *initialized* Rapier module and world in — this file never imports Rapier,
// so it stays engine-version-agnostic and tree-shakeable.

import { Vector3 } from "three";
import type RAPIER from "@dimforge/rapier3d-compat";

const EPS = 1e-6;
const UP: RAPIER.Vector = { x: 0, y: 1, z: 0 };

export type ActorCollisionMode =
  // Resolve against static world only; queued actors don't block each other.
  | "ignore-actors"
  // Resolve all actors from their frame-start positions; order doesn't matter.
  | "start-positions"
  // Resolve actors one at a time; earlier moves can block later ones.
  | "sequential";

export type ColliderShape =
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
  colliderShape: ColliderShape;
  colliderOptions?: ColliderOptions;
  controllerOptions?: ControllerOptions;
  /** Per-actor override of the batch collision mode. */
  actorCollisionMode?: ActorCollisionMode;
  /** Extra downward shapecast distance to still count as grounded (0 = disabled). */
  groundedProbeDistance?: number;
}

export interface Actor {
  readonly characterController: RAPIER.KinematicCharacterController;
  readonly rigidBody: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly bodyOffset: Vector3;
  readonly groundedProbeDistance: number;
  readonly actorCollisionMode: ActorCollisionMode | null;
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

function toVec3(value?: Vector3): Vector3 {
  return value ? value.clone() : new Vector3();
}

function createColliderDesc(
  rapier: typeof RAPIER,
  shape: ColliderShape,
  options: ColliderOptions,
): RAPIER.ColliderDesc {
  let desc: RAPIER.ColliderDesc;
  if (shape.type === "capsule") desc = rapier.ColliderDesc.capsule(shape.halfHeight, shape.radius);
  else if (shape.type === "cuboid")
    desc = rapier.ColliderDesc.cuboid(shape.halfX, shape.halfY, shape.halfZ);
  else desc = rapier.ColliderDesc.ball(shape.radius);

  desc.setFriction(options.friction ?? 0);
  desc.setRestitution(options.restitution ?? 0);
  if (typeof options.collisionGroups === "number") desc.setCollisionGroups(options.collisionGroups);
  if (typeof options.solverGroups === "number") desc.setSolverGroups(options.solverGroups);
  if (typeof options.sensor === "boolean") desc.setSensor(options.sensor);
  return desc;
}

function configureController(
  controller: RAPIER.KinematicCharacterController,
  options: ControllerOptions,
): void {
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
  if (typeof options.snapToGround === "number" && options.snapToGround > 0) {
    controller.enableSnapToGround(options.snapToGround);
  } else {
    controller.disableSnapToGround();
  }
  if (typeof options.maxSlopeClimbAngle === "number")
    controller.setMaxSlopeClimbAngle(options.maxSlopeClimbAngle);
  if (typeof options.minSlopeSlideAngle === "number")
    controller.setMinSlopeSlideAngle(options.minSlopeSlideAngle);
  if (typeof options.applyImpulsesToDynamicBodies === "boolean")
    controller.setApplyImpulsesToDynamicBodies(options.applyImpulsesToDynamicBodies);
  if (typeof options.characterMass === "number") controller.setCharacterMass(options.characterMass);
  if (typeof options.slide === "boolean") controller.setSlideEnabled(options.slide);
}

export class KinematicResolver {
  private readonly actorColliderHandles = new Set<number>();
  private readonly queuedMoves: QueuedMove[] = [];
  private readonly results = new Map<Actor, MoveResult>();

  constructor(
    private readonly world: RAPIER.World,
    private readonly rapier: typeof RAPIER,
    private readonly defaultMode: ActorCollisionMode = "start-positions",
    private readonly minStepSeconds = 1 / 240,
  ) {}

  createActor(options: CreateActorOptions): Actor {
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
      createColliderDesc(this.rapier, options.colliderShape, options.colliderOptions ?? {}),
      rigidBody,
    );

    const actor: Actor = {
      characterController,
      rigidBody,
      collider,
      bodyOffset,
      groundedProbeDistance: options.groundedProbeDistance ?? 0,
      actorCollisionMode: options.actorCollisionMode ?? null,
    };
    this.actorColliderHandles.add(collider.handle);
    this.world.updateSceneQueries();
    return actor;
  }

  /** Clear last frame's queued moves and results. Call once per frame before queueing. */
  beginFrame(): void {
    this.queuedMoves.length = 0;
    this.results.clear();
  }

  /** Teleport an actor (e.g. respawn) without a collision sweep. */
  syncActor(actor: Actor, position: Vector3): void {
    const bodyPosition = position.clone().add(actor.bodyOffset);
    actor.rigidBody.setTranslation(bodyPosition, true);
    actor.rigidBody.setNextKinematicTranslation(bodyPosition);
  }

  queueMove(actor: Actor, move: MoveRequest): void {
    this.queuedMoves.push({
      actor,
      startPosition: toVec3(move.startPosition),
      desiredDelta: toVec3(move.desiredDelta),
      deltaSeconds: move.deltaSeconds,
    });
  }

  resolveQueuedMoves(
    deltaSeconds = 1 / 60,
    mode: ActorCollisionMode = this.defaultMode,
  ): Map<Actor, MoveResult> {
    this.results.clear();

    if (mode === "sequential") {
      for (const move of this.queuedMoves) {
        this.syncActor(move.actor, move.startPosition);
        this.world.updateSceneQueries();
        this.results.set(
          move.actor,
          this.resolveMove(move, this.actorFilter(move.actor, mode), true, deltaSeconds),
        );
      }
    } else {
      for (const move of this.queuedMoves) this.syncActor(move.actor, move.startPosition);
      this.world.updateSceneQueries();

      for (const move of this.queuedMoves) {
        this.results.set(
          move.actor,
          this.resolveMove(move, this.actorFilter(move.actor, mode), false, deltaSeconds),
        );
      }
    }

    // Clear the queue so a second resolve (or a missing beginFrame) can't replay moves.
    this.queuedMoves.length = 0;
    this.stepWorld(deltaSeconds);
    return this.results;
  }

  getResult(actor: Actor): MoveResult | null {
    return this.results.get(actor) ?? null;
  }

  /** Rapier collision filter honoring the actor's `ignore-actors` mode, in every batch mode. */
  private actorFilter(
    actor: Actor,
    mode: ActorCollisionMode,
  ): ((collider: RAPIER.Collider) => boolean) | undefined {
    const actorMode = actor.actorCollisionMode ?? mode;
    return actorMode === "ignore-actors"
      ? (collider) => !this.actorColliderHandles.has(collider.handle)
      : undefined;
  }

  private resolveMove(
    move: QueuedMove,
    filter: ((collider: RAPIER.Collider) => boolean) | undefined,
    commitTranslation: boolean,
    fallbackDeltaSeconds: number,
  ): MoveResult {
    const { actor, desiredDelta } = move;
    // A move queued without its own dt still needs one to derive velocity; fall back
    // to the physics step so reported velocity matches actual displacement.
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
    if (commitTranslation) actor.rigidBody.setTranslation(nextBody, true);
    actor.rigidBody.setNextKinematicTranslation(nextBody);

    const position = new Vector3(
      nextBody.x - actor.bodyOffset.x,
      nextBody.y - actor.bodyOffset.y,
      nextBody.z - actor.bodyOffset.z,
    );
    const velocity =
      deltaSeconds > EPS ? correctedDelta.clone().multiplyScalar(1 / deltaSeconds) : new Vector3();
    const collisions = actor.characterController.numComputedCollisions();
    // Probe from the post-move position: the collider itself isn't repositioned until
    // world.step() runs, so casting from its current translation would use the stale
    // frame-start spot and keep an actor "grounded" after it walked off a ledge.
    const grounded =
      actor.characterController.computedGrounded() || this.probeGrounded(actor, nextBody);

    return {
      position,
      velocity,
      correctedDelta,
      grounded,
      blocked: collisions > 0,
      collisions,
    };
  }

  private probeGrounded(actor: Actor, origin: RAPIER.Vector): boolean {
    const distance = Math.max(0, actor.groundedProbeDistance);
    if (distance <= 0) return false;
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

  private stepWorld(deltaSeconds: number): void {
    if (deltaSeconds <= 0) return;
    this.world.timestep = Math.max(this.minStepSeconds, deltaSeconds);
    this.world.step();
    this.world.updateSceneQueries();
  }
}
