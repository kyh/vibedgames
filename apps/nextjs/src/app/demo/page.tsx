"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  MultiplayerProvider,
  useConnectionStatus,
  useIsHost,
  useMultiplayerState,
  usePlayerState,
  usePlayers,
} from "@repo/multiplayer";

import { Background } from "@/app/(home)/_components/background";

type Point = { x: number; y: number };
type CursorState = {
  position: Point | null;
  pointer?: "mouse" | "touch" | "pen" | "unknown";
};
type SharedState = {
  background: string;
  sessionName: string;
};

type PlayerMetaState = CursorState;

const HOST =
  process.env.NODE_ENV === "development"
    ? "http://localhost:8787"
    : "https://vg-partyserver.kyh.workers.dev";
const PARTY = "vg-server";
const ROOM = "playroom-demo";

const INITIAL_SHARED_STATE: SharedState = {
  background: "#020617",
  sessionName: "Playroom Demo",
};

const INITIAL_PLAYER_STATE: CursorState = {
  position: null,
  pointer: "unknown",
};

const Page = () => {
  return (
    <>
      <MultiplayerProvider
        host={HOST}
        party={PARTY}
        room={ROOM}
        initialSharedState={INITIAL_SHARED_STATE}
        initialPlayerState={INITIAL_PLAYER_STATE}
      >
        <DemoExperience />
      </MultiplayerProvider>
      <Background />
    </>
  );
};

const DemoExperience = () => {
  const status = useConnectionStatus();
  const isHost = useIsHost();
  const players = usePlayers<PlayerMetaState>();
  const [sharedState, setSharedState] = useMultiplayerState<SharedState>();
  const [playerState, setPlayerState, player] = usePlayerState<PlayerMetaState>();

  const hasInitialised = useRef(false);

  useEffect(() => {
    if (hasInitialised.current) return;
    hasInitialised.current = true;

    const randomPosition = () => ({
      x: Math.round(window.innerWidth * Math.random()),
      y: Math.round(window.innerHeight * Math.random()),
    });

    setPlayerState(() => ({
      position: randomPosition(),
      pointer: "mouse",
    }));
  }, [setPlayerState]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const pointerType = event.pointerType;
      const normalizedPointer: CursorState["pointer"] =
        pointerType === "mouse" || pointerType === "touch" || pointerType === "pen"
          ? pointerType
          : "unknown";

      setPlayerState((prev) => ({
        ...prev,
        position: { x: event.clientX, y: event.clientY },
        pointer: normalizedPointer,
      }));
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
    };
  }, [setPlayerState]);

  const activePlayers = useMemo(() => {
    return players
      .map((entry) => {
        const position = entry.state.position;
        if (!position) {
          return null;
        }

        return {
          id: entry.id,
          color: entry.color ?? "#38bdf8",
          hue: entry.hue ?? "#0ea5e9",
          position,
          pointer: entry.state.pointer ?? "unknown",
          isSelf: entry.id === player?.id,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }, [player?.id, players]);

  return (
    <main
      className="relative flex h-[calc(100vh-8rem)] flex-col gap-6 overflow-hidden rounded-3xl border border-white/10 bg-black/40 p-6 backdrop-blur"
      style={{ background: sharedState.background }}
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-white/60">Session</p>
          <h1 className="text-2xl font-semibold text-white">{sharedState.sessionName}</h1>
          <p className="text-sm text-white/60">Connection: {status}</p>
          {playerState.position && (
            <p className="mt-2 text-xs text-white/50">
              Pointer: {playerState.pointer} @ {playerState.position.x}, {playerState.position.y}
            </p>
          )}
        </div>
        {isHost && (
          <div className="flex flex-col items-end gap-2">
            <button
              className="rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-cyan-500/20 transition hover:bg-white/20"
              onClick={() => {
                setSharedState((prev) => ({
                  ...prev,
                  background: `hsl(${Math.round(Math.random() * 360)}, 45%, 12%)`,
                }));
              }}
            >
              Shuffle Background
            </button>
            <button
              className="rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-cyan-500/20 transition hover:bg-white/20"
              onClick={() => {
                setSharedState((prev) => ({
                  ...prev,
                  sessionName: `Session ${Math.floor(Math.random() * 1000)}`,
                }));
              }}
            >
              Rename Session
            </button>
          </div>
        )}
      </header>

      <section className="flex flex-1 flex-col gap-4 overflow-hidden">
        <div className="flex items-center justify-between text-sm text-white/70">
          <span>{players.length} player{players.length === 1 ? "" : "s"} connected</span>
          {player && (
            <span>
              You are <strong className="text-white">{player.id.slice(0, 6)}</strong>
              {isHost ? " · Host" : ""}
            </span>
          )}
        </div>

        <div className="relative flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black/30">
          {activePlayers.map((cursor) => (
            <div
              key={cursor.id}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
              style={{ left: cursor.position.x, top: cursor.position.y }}
            >
              <div
                className="h-10 w-10 rounded-full border-2 shadow-xl shadow-black/40"
                style={{ background: cursor.color, borderColor: cursor.hue }}
              />
              <span className="rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white/80">
                {cursor.isSelf ? "You" : cursor.id.slice(0, 4)} · {cursor.pointer}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
};

export default Page;
