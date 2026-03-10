"use client";

import type { DataUIPart } from "ai";
import { create } from "zustand";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { featuredGames } from "./data";

type View = "build" | "play" | "discover";

type Command = {
  background?: boolean;
  sandboxId: string;
  cmdId: string;
  startedAt: number;
  command: string;
  args: string[];
  exitCode?: number;
};

type UIState = {
  // General view state
  view: View;
  setView: (view: View) => void;
  iframe: HTMLIFrameElement | null;
  setIframe: (iframe: HTMLIFrameElement | null) => void;
  refreshIframe: () => void;
  iframeLoading: boolean;
  setIframeLoading: (loading: boolean) => void;
  iframeError: string | null;
  setIframeError: (error: string | null) => void;
  // View == build states
  showFileExplorer: boolean;
  setShowFileExplorer: (show: boolean) => void;
  showMyGames: boolean;
  setShowMyGames: (show: boolean) => void;
  showLogs: boolean;
  setShowLogs: (show: boolean) => void;
  logs: string[];
  appendLog: (log: string) => void;
  // View == play/build states
  gameId: string; // Game ID is a string for local games, and a url for remote games
  setGameId: (id: string) => void;
  isLocalGame: boolean;
  // Sandbox state
  sandboxId?: string;
  setSandboxId: (id: string) => void;
  sandboxUrl?: string;
  setSandboxUrl: (url: string) => void;
  sandboxStatus?: "running" | "stopped";
  setSandboxStatus: (status: "running" | "stopped") => void;
  commands: Command[];
  upsertCommand: (command: Omit<Command, "startedAt">) => void;
  resetSandbox: () => void;
};

export const useUiStore = create<UIState>((set, get) => ({
  view: "play",
  setView: (view) => set({ view }),
  iframe: null,
  setIframe: (iframe) => set({ iframe: iframe }),
  refreshIframe: () => {
    const iframe = get().iframe;
    if (!iframe) return;

    // Set loading state and clear any errors
    set({ iframeLoading: true, iframeError: null });

    const newUrl = new URL(iframe.src);
    newUrl.searchParams.set("t", Date.now().toString());
    iframe.src = newUrl.toString();
  },
  iframeLoading: false,
  setIframeLoading: (loading) => set({ iframeLoading: loading }),
  iframeError: null,
  setIframeError: (error) => set({ iframeError: error }),
  // View == build states
  showFileExplorer: false,
  setShowFileExplorer: (show) => set({ showFileExplorer: show }),
  showMyGames: false,
  setShowMyGames: (show) => set({ showMyGames: show }),
  showLogs: false,
  setShowLogs: (show) => set({ showLogs: show }),
  logs: [],
  appendLog: (log) => set((state) => ({ logs: [...state.logs, log] })),
  // View == play/build states
  gameId: featuredGames[0]?.url ?? "",
  setGameId: (id) => {
    set({
      gameId: id,
      isLocalGame: true,
    });
  },
  isLocalGame: false,
  // Sandbox state
  sandboxId: undefined,
  setSandboxId: (sandboxId) =>
    set(() => ({
      sandboxId,
      sandboxStatus: "running",
      commands: [],
      sandboxUrl: undefined,
    })),
  sandboxUrl: undefined,
  setSandboxUrl: (url) => set(() => ({ sandboxUrl: url })),
  sandboxStatus: undefined,
  setSandboxStatus: (status) => set(() => ({ sandboxStatus: status })),
  commands: [],
  upsertCommand: (cmd) => {
    set((state) => {
      const existingIdx = state.commands.findIndex(
        (c) => c.cmdId === cmd.cmdId,
      );
      const idx = existingIdx !== -1 ? existingIdx : state.commands.length;
      const prev = state.commands[idx] ?? { startedAt: Date.now() };
      const cmds = [...state.commands];
      cmds[idx] = { ...prev, ...cmd };
      return { commands: cmds };
    });
  },
  resetSandbox: () =>
    set(() => ({
      sandboxId: undefined,
      sandboxUrl: undefined,
      sandboxStatus: undefined,
      commands: [],
    })),
}));

export function useDataStateMapper() {
  const { setSandboxId, setSandboxUrl, upsertCommand } = useUiStore();

  return (data: DataUIPart<DataPart>) => {
    switch (data.type) {
      case "data-create-sandbox":
        if (data.data.sandboxId) {
          setSandboxId(data.data.sandboxId);
        }
        break;
      case "data-run-command":
        if (
          data.data.commandId &&
          (data.data.status === "executing" || data.data.status === "running")
        ) {
          upsertCommand({
            background: data.data.status === "running",
            sandboxId: data.data.sandboxId,
            cmdId: data.data.commandId,
            command: data.data.command,
            args: data.data.args,
          });
        }
        break;
      case "data-get-sandbox-url":
        if (data.data.url) {
          setSandboxUrl(data.data.url);
        }
        break;
      default:
        break;
    }
  };
}
