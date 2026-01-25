"use client";

import type { DataUIPart } from "ai";
import { create } from "zustand";

import type {
  SandpackBundlerFiles,
  SandpackClient,
} from "@codesandbox/sandpack-client";
import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { featuredGames } from "./data";
import { initializeSandpackClient, toSandpack } from "./sandpack";

type View = "build" | "play" | "discover";

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
  setGameId: (id: string, files?: SandpackBundlerFiles) => void;
  isLocalGame: boolean;
  // Sandpack state
  initializingGameId: string | null; // Track which gameId is currently initializing
  sandpackClient: SandpackClient | null;
  sandpackFiles: SandpackBundlerFiles;
  updateSandpackFiles: (files: SandpackBundlerFiles) => void;
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
  setGameId: (id, files) => {
    const {
      sandpackClient,
      iframe,
      setIframeLoading,
      setIframeError,
      gameId: currentGameId,
      isLocalGame: currentIsLocal,
      initializingGameId,
    } = get();
    const isLocalGame = !!files;

    // Skip if already initialized or initializing for this gameId with same mode
    const alreadyInitialized = currentGameId === id && currentIsLocal === isLocalGame && sandpackClient;
    const alreadyInitializing = initializingGameId === id && isLocalGame;
    console.log("[setGameId]", { id, isLocalGame, alreadyInitialized, alreadyInitializing });
    if (alreadyInitialized || alreadyInitializing) {
      console.log("[setGameId] skipping - already initialized/initializing");
      return;
    }

    if (sandpackClient) {
      sandpackClient.destroy();
      set({ sandpackClient: null });
    }

    set({
      gameId: id,
      sandpackFiles: isLocalGame ? files : {},
      isLocalGame,
      initializingGameId: isLocalGame ? id : null,
    });

    // If local game, reinitialize sandpack
    if (isLocalGame) {
      void initializeSandpackClient({
        iframe,
        files,
        onClientReady: (client) => {
          // Only set client if still initializing the same game
          const currentInitId = get().initializingGameId;
          console.log("[onClientReady]", { id, currentInitId, match: currentInitId === id });
          if (currentInitId === id) {
            const currentFiles = get().sandpackFiles;
            console.log("[onClientReady] syncing files:", Object.keys(currentFiles));
            set({ sandpackClient: client, initializingGameId: null });
            // Sync any files that arrived during initialization
            client.updateSandbox({ files: currentFiles });
          } else {
            // Different game requested, destroy this client
            console.log("[onClientReady] destroying - different game requested");
            client.destroy();
          }
        },
        onLoadingChange: (loading) => {
          setIframeLoading(loading);
        },
        onError: (error) => {
          setIframeError(error);
          set({ initializingGameId: null });
        },
        onLog: (log) => {
          get().appendLog(log);
        },
      });
    }
  },
  isLocalGame: false,
  // Sandpack state
  initializingGameId: null,
  sandpackClient: null,
  sandpackFiles: {},
  updateSandpackFiles: (files) => {
    const { sandpackFiles, sandpackClient } = get();
    const newFiles = { ...sandpackFiles, ...files };
    console.log("[updateSandpackFiles] files:", Object.keys(files), "client:", !!sandpackClient);
    set({ sandpackFiles: newFiles });

    if (sandpackClient) {
      sandpackClient.updateSandbox({
        files: newFiles,
      });
    }
  },
}));

export function useDataStateMapper() {
  const { updateSandpackFiles } = useUiStore();

  return (data: DataUIPart<DataPart>) => {
    switch (data.type) {
      case "data-generating-files":
        if (data.data.files) {
          updateSandpackFiles(toSandpack(data.data.files));
        }
        break;
      default:
        break;
    }
  };
}
