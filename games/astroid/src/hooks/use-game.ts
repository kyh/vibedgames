import { useCallback, useEffect, useRef, useState } from "react";
import { useMultiplayerRoom } from "@repo/multiplayer";
import { useIsHost } from "@repo/multiplayer";

import type {
  Asteroid,
  Beam,
  Camera,
  Item,
  PlayerGameState,
  SerializedBeam,
  SharedGameState,
  Ship,
  Splinter,
  UFO,
  Point,
  Weapon,
} from "../game/types";
import {
  FPS,
  NETWORK_FRAME_SKIP,
  RESPAWN_DELAY_MS,
  INVULNERABLE_MS,
  ASTEROID_MAX_NUM,
  ASTEROID_SPAWN_INTERVAL,
  UFO_SPAWN_CHANCE,
  SCORE,
  WEAPON_DEFAULT,
  SPECIAL_WEAPON_DURATION_MS,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  ASTEROID_MAX_SIZE,
} from "../game/constants";
import {
  createShip,
  updateShip,
  createBeam,
  updateBeam,
  beamHit,
  spawnAsteroid,
  updateAsteroid,
  damageAsteroid,
  createUFO,
  updateUFO,
  damageUFO,
  createItem,
  updateItem,
  createSplinter,
  isSplinterDone,
  updateSplinter,
} from "../game/entities";
import { segmentCircleIntersect, circleContains, randomWorldPoint } from "../game/math";
import { render, renderMinimap } from "../game/renderer";
import type { MinimapDot } from "../game/renderer";
import type { Player } from "@repo/multiplayer";

const HOST = "https://vibedgames-party.kyh.workers.dev";
const PARTY = "vg-server";
const ROOM = "home";

type EventPayload =
  | { type: "asteroid_hit"; asteroidId: string; damage: number; playerId: string }
  | { type: "ufo_hit"; damage: number; playerId: string }
  | { type: "item_pickup"; itemId: string; playerId: string }
  | { type: "player_killed"; killerId: string; victimId: string };

function serializeBeams(beams: Beam[]): SerializedBeam[] {
  return beams
    .filter((b) => !b.vanished)
    .map((b) => ({
      hx: b.head.x,
      hy: b.head.y,
      tx: b.tail.x,
      ty: b.tail.y,
      angle: b.angle,
      color: b.weapon.color,
      width: b.weapon.width,
      exploding: b.exploding,
      explosionRadius: b.explosionRadius,
    }));
}

export function useGame(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  minimapRef: React.RefObject<HTMLCanvasElement | null>,
) {
  // --- Multiplayer ---
  const eventQueueRef = useRef<EventPayload[]>([]);

  const handleEvent = useCallback(
    (event: string, payload: unknown, _from: string) => {
      eventQueueRef.current.push(payload as EventPayload);
    },
    [],
  );

  const room = useMultiplayerRoom<SharedGameState>({
    host: HOST,
    party: PARTY,
    room: ROOM,
    onEvent: handleEvent,
    initialState: {
      asteroids: [],
      ufo: null,
      items: [],
    },
  });

  const isHost = useIsHost(room);

  // --- React state for HUD (updated at lower frequency) ---
  const [score, setScore] = useState(0);
  const [weaponName, setWeaponName] = useState(WEAPON_DEFAULT.name);
  const [alive, setAlive] = useState(true);
  const [respawnCountdown, setRespawnCountdown] = useState(0);
  const [playerCount, setPlayerCount] = useState(0);

  // --- Refs for game loop (mutable, no re-renders) ---
  const shipRef = useRef<Ship | null>(null);
  const beamsRef = useRef<Beam[]>([]);
  const splintersRef = useRef<Splinter[]>([]);
  const mouseRef = useRef<Point>({ x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 });
  const mouseDownRef = useRef(false);
  const cameraRef = useRef<Camera>({ x: 0, y: 0 });
  const scoreRef = useRef(0);
  const weaponRef = useRef<Weapon>(WEAPON_DEFAULT);
  const weaponSetTimeRef = useRef(0);
  const canShootRef = useRef(true);
  const frameCountRef = useRef(0);
  const lastAsteroidSpawnRef = useRef(0);
  const isHostRef = useRef(false);
  const aliveRef = useRef(true);
  const invulnerableRef = useRef(false);
  const invulnerableUntilRef = useRef(0);
  const respawnAtRef = useRef(0);

  // Keep shared state in a ref for the game loop to read
  const sharedStateRef = useRef<SharedGameState>({
    asteroids: [],
    ufo: null,
    items: [],
  });
  const playersRef = useRef(room.players);
  const playerIdRef = useRef(room.playerId);
  const roomRef = useRef(room);

  // Sync React state → refs
  useEffect(() => {
    sharedStateRef.current = room.sharedState;
  }, [room.sharedState]);
  useEffect(() => {
    playersRef.current = room.players;
    setPlayerCount(Object.keys(room.players).length);
  }, [room.players]);
  useEffect(() => {
    playerIdRef.current = room.playerId;
  }, [room.playerId]);
  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // --- Initialize ship on connect ---
  useEffect(() => {
    if (room.connectionStatus === "connected" && !shipRef.current && room.playerId) {
      const pos = randomWorldPoint();
      shipRef.current = createShip(pos.x, pos.y);
      mouseRef.current = { ...pos };
      cameraRef.current = {
        x: pos.x - window.innerWidth / 2,
        y: pos.y - window.innerHeight / 2,
      };
    }
  }, [room.connectionStatus, room.playerId]);

  // --- Input handlers ---
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      // Convert screen coords to world coords via camera
      mouseRef.current = {
        x: e.clientX + cameraRef.current.x,
        y: e.clientY + cameraRef.current.y,
      };
    };
    const handleDown = () => { mouseDownRef.current = true; };
    const handleUp = () => { mouseDownRef.current = false; };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handleDown);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleDown);
      window.removeEventListener("pointerup", handleUp);
    };
  }, []);

  // --- Main game loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const interval = setInterval(() => {
      const now = Date.now();
      frameCountRef.current++;

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      const pid = playerIdRef.current;
      if (!pid) return;

      // ---- Respawn logic ----
      if (!aliveRef.current && respawnAtRef.current > 0 && now >= respawnAtRef.current) {
        const pos = randomWorldPoint();
        shipRef.current = createShip(pos.x, pos.y);
        mouseRef.current = { ...pos };
        aliveRef.current = true;
        invulnerableRef.current = true;
        invulnerableUntilRef.current = now + INVULNERABLE_MS;
        setAlive(true);
      }

      // ---- Invulnerability expiry ----
      if (invulnerableRef.current && now >= invulnerableUntilRef.current) {
        invulnerableRef.current = false;
      }

      // ---- Respawn countdown for HUD ----
      if (!aliveRef.current && respawnAtRef.current > 0) {
        setRespawnCountdown(Math.max(0, Math.ceil((respawnAtRef.current - now) / 1000)));
      }

      // ---- Update my ship ----
      if (shipRef.current && aliveRef.current) {
        shipRef.current = updateShip(shipRef.current, mouseRef.current);

        // Camera follows ship
        cameraRef.current = {
          x: shipRef.current.position.x - window.innerWidth / 2,
          y: shipRef.current.position.y - window.innerHeight / 2,
        };
      }

      // ---- Weapon timeout ----
      if (weaponRef.current !== WEAPON_DEFAULT && now - weaponSetTimeRef.current > SPECIAL_WEAPON_DURATION_MS) {
        weaponRef.current = WEAPON_DEFAULT;
        setWeaponName(WEAPON_DEFAULT.name);
      }

      // ---- Shooting ----
      if (mouseDownRef.current && aliveRef.current && canShootRef.current && shipRef.current) {
        const beam = createBeam(shipRef.current, weaponRef.current, pid);
        beamsRef.current.push(beam);
        canShootRef.current = false;
        setTimeout(() => { canShootRef.current = true; }, weaponRef.current.shootingInterval);
      }

      // ---- Update my beams ----
      beamsRef.current = beamsRef.current
        .map(updateBeam)
        .filter((b) => !b.vanished);

      // ---- Read shared state ----
      const shared = sharedStateRef.current;

      // ---- My beams vs asteroids ----
      for (const beam of beamsRef.current) {
        if (beam.vanished) continue;
        for (const asteroid of shared.asteroids) {
          const hit = beam.exploding
            ? circleContains(beam.head, beam.explosionRadius, asteroid.position)
            : segmentCircleIntersect(beam.tail, beam.head, asteroid.position, asteroid.radius);
          if (hit) {
            const wasBeam = beamHit(beam);
            Object.assign(beam, wasBeam);
            scoreRef.current += SCORE.ASTEROID_DAMAGE;
            setScore(scoreRef.current);
            roomRef.current.sendEvent("game", {
              type: "asteroid_hit",
              asteroidId: asteroid.id,
              damage: beam.weapon.power,
              playerId: pid,
            } satisfies EventPayload);
            break;
          }
        }
      }

      // ---- My beams vs UFO ----
      if (shared.ufo) {
        for (const beam of beamsRef.current) {
          if (beam.vanished) continue;
          const hit = beam.exploding
            ? circleContains(beam.head, beam.explosionRadius, shared.ufo.position)
            : segmentCircleIntersect(beam.tail, beam.head, shared.ufo.position, 15);
          if (hit) {
            const wasBeam = beamHit(beam);
            Object.assign(beam, wasBeam);
            roomRef.current.sendEvent("game", {
              type: "ufo_hit",
              damage: beam.weapon.power,
              playerId: pid,
            } satisfies EventPayload);
            break;
          }
        }
      }

      // ---- Asteroids vs my ship (death) ----
      if (aliveRef.current && !invulnerableRef.current && shipRef.current) {
        for (const asteroid of shared.asteroids) {
          if (circleContains(asteroid.position, asteroid.radius, shipRef.current.position)) {
            die(now);
            break;
          }
        }
      }

      // ---- UFO vs my ship ----
      if (aliveRef.current && !invulnerableRef.current && shipRef.current && shared.ufo) {
        if (circleContains(shared.ufo.position, 15, shipRef.current.position)) {
          die(now);
        }
      }

      // ---- Other players' beams vs my ship (PvP) ----
      if (aliveRef.current && !invulnerableRef.current && shipRef.current) {
        const players = playersRef.current;
        for (const [otherId, player] of Object.entries(players)) {
          if (otherId === pid) continue;
          const state = player.state as PlayerGameState | undefined;
          if (!state?.beams) continue;
          for (const sb of state.beams) {
            const hit = sb.exploding
              ? circleContains({ x: sb.hx, y: sb.hy }, sb.explosionRadius, shipRef.current.position)
              : segmentCircleIntersect(
                  { x: sb.tx, y: sb.ty },
                  { x: sb.hx, y: sb.hy },
                  shipRef.current.position,
                  shipRef.current.size,
                );
            if (hit) {
              die(now);
              roomRef.current.sendEvent("game", {
                type: "player_killed",
                killerId: otherId,
                victimId: pid,
              } satisfies EventPayload);
              break;
            }
          }
          if (!aliveRef.current) break;
        }
      }

      // ---- Item pickup ----
      if (aliveRef.current && shipRef.current) {
        for (const item of shared.items) {
          if (circleContains(item.position, 15, shipRef.current.position)) {
            weaponRef.current = item.weapon;
            weaponSetTimeRef.current = now;
            setWeaponName(item.weapon.name);
            roomRef.current.sendEvent("game", {
              type: "item_pickup",
              itemId: item.id,
              playerId: pid,
            } satisfies EventPayload);
          }
        }
      }

      // ---- HOST: world simulation ----
      if (isHostRef.current) {
        hostTick(now);
      }

      // ---- Update splinters ----
      splintersRef.current = splintersRef.current
        .map(updateSplinter)
        .filter((s) => !isSplinterDone(s));

      // ---- Network broadcast (throttled) ----
      if (frameCountRef.current % NETWORK_FRAME_SKIP === 0) {
        const myState: PlayerGameState = {
          x: shipRef.current?.position.x ?? 0,
          y: shipRef.current?.position.y ?? 0,
          angle: shipRef.current?.angle ?? 0,
          alive: aliveRef.current,
          score: scoreRef.current,
          weaponName: weaponRef.current.name,
          shooting: mouseDownRef.current,
          beams: serializeBeams(beamsRef.current),
        };
        roomRef.current.updateMyState(myState);
      }

      // ---- Render ----
      const otherPlayers = Object.entries(playersRef.current)
        .filter(([id]) => id !== pid)
        .map(([, p]) => {
          const state = p.state as PlayerGameState | undefined;
          // Build a simple path from position + angle for other players
          const pos = state ? { x: state.x, y: state.y } : { x: 0, y: 0 };
          const ang = state?.angle ?? 0;
          const path = buildShipPath(pos, ang);
          return {
            path,
            color: p.color ?? "rgb(255, 255, 255)",
            alive: state?.alive ?? true,
            invulnerable: false,
            beams: state?.beams ?? [],
          };
        });

      render(ctx, canvas.width, canvas.height, {
        camera: cameraRef.current,
        myShip: shipRef.current,
        myBeams: beamsRef.current,
        myColor: playersRef.current[pid]?.color ?? "rgb(255, 255, 255)",
        myInvulnerable: invulnerableRef.current,
        otherPlayers,
        asteroids: shared.asteroids,
        ufo: shared.ufo,
        items: shared.items,
        splinters: splintersRef.current,
      });

      // ---- Minimap ----
      const minimapCanvas = minimapRef.current;
      if (minimapCanvas) {
        const mctx = minimapCanvas.getContext("2d");
        if (mctx) {
          const dots: MinimapDot[] = Object.entries(playersRef.current).map(([id, p]) => {
            const state = p.state as PlayerGameState | undefined;
            return {
              x: state?.x ?? 0,
              y: state?.y ?? 0,
              color: p.color ?? "white",
              isMe: id === pid,
            };
          }).filter((d) => {
            const state = playersRef.current[pid]?.state as PlayerGameState | undefined;
            return d.isMe ? aliveRef.current : (state?.alive ?? true);
          });
          renderMinimap(mctx, minimapCanvas.width, dots, shared.asteroids);
        }
      }
    }, 1000 / FPS);

    return () => clearInterval(interval);
  }, [canvasRef, minimapRef]);

  // ---- Helper: die ----
  function die(now: number) {
    if (shipRef.current) {
      splintersRef.current.push(
        createSplinter(
          shipRef.current.position.x,
          shipRef.current.position.y,
          50,
          30,
        ),
      );
    }

    aliveRef.current = false;
    invulnerableRef.current = false;
    respawnAtRef.current = now + RESPAWN_DELAY_MS;
    shipRef.current = null;
    beamsRef.current = [];
    setAlive(false);
  }

  // ---- HOST tick ----
  function hostTick(now: number) {
    const shared = sharedStateRef.current;
    let asteroids = [...shared.asteroids];
    let ufo = shared.ufo;
    let items = [...shared.items];
    let changed = false;

    // Process event queue
    const events = eventQueueRef.current.splice(0);
    for (const evt of events) {
      switch (evt.type) {
        case "asteroid_hit": {
          const idx = asteroids.findIndex((a) => a.id === evt.asteroidId);
          if (idx !== -1) {
            const { asteroid } = damageAsteroid(asteroids[idx], evt.damage);
            if (asteroid) {
              asteroids[idx] = asteroid;
            } else {
              // Destroyed
              splintersRef.current.push(
                createSplinter(asteroids[idx].position.x, asteroids[idx].position.y, asteroids[idx].radius, 20),
              );
              asteroids.splice(idx, 1);
            }
            changed = true;
          }
          break;
        }
        case "ufo_hit": {
          if (ufo) {
            ufo = damageUFO(ufo, evt.damage);
            if (ufo.hp <= 0) {
              splintersRef.current.push(
                createSplinter(ufo.position.x, ufo.position.y, 25, 20),
              );
              items.push(createItem(ufo.position.x, ufo.position.y));
              ufo = null;
            }
            changed = true;
          }
          break;
        }
        case "item_pickup": {
          const idx = items.findIndex((i) => i.id === evt.itemId);
          if (idx !== -1) {
            items.splice(idx, 1);
            changed = true;
          }
          break;
        }
        case "player_killed": {
          // Score is handled client-side by the killer via their own detection
          // This event is mainly informational; host doesn't need to act
          break;
        }
      }
    }

    // Spawn asteroids
    if (asteroids.length < ASTEROID_MAX_NUM && now - lastAsteroidSpawnRef.current > ASTEROID_SPAWN_INTERVAL) {
      asteroids.push(spawnAsteroid());
      lastAsteroidSpawnRef.current = now;
      changed = true;
    }

    // Update asteroids, remove out-of-bounds
    asteroids = asteroids.map(updateAsteroid).filter((a) => !a.outOfBounds);

    // UFO spawn
    if (!ufo && items.length === 0 && Math.random() < UFO_SPAWN_CHANCE) {
      ufo = createUFO();
      changed = true;
    }

    // Update UFO
    if (ufo) {
      ufo = updateUFO(ufo);
    }

    // Update items
    items = items.map(updateItem).filter((i) => i.lifetime > 0);

    // Broadcast at network rate
    if (frameCountRef.current % NETWORK_FRAME_SKIP === 0 || changed) {
      roomRef.current.updateSharedState({
        asteroids,
        ufo,
        items,
      });
    }

    // Update local ref immediately for rendering
    sharedStateRef.current = { asteroids, ufo, items };
  }

  return {
    room,
    score,
    weaponName,
    alive,
    respawnCountdown,
    playerCount,
  };
}

/** Build a ship path from position + angle (for rendering other players) */
function buildShipPath(position: Point, ang: number): Point[] {
  const size = 8;
  const DEG_TO_RAD = Math.PI / 180;
  const angles = [0, 140, 180, 220];
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);

  return angles.map((deg, i) => {
    const a = DEG_TO_RAD * deg;
    const r = i === 2 ? size / 2 : size;
    const rx = r * Math.cos(a);
    const ry = r * Math.sin(a);
    return {
      x: position.x + rx * cos - ry * sin,
      y: position.y + rx * sin + ry * cos,
    };
  });
}
