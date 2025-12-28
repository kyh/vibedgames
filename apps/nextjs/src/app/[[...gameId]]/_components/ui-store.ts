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
  showBuildMenu: boolean;
  setShowBuildMenu: (show: boolean) => void;
  showMyGames: boolean;
  setShowMyGames: (show: boolean) => void;
  // View == play/build states
  gameId: string; // Game ID is a string for local games, and a url for remote games
  setGameId: (id: string, files?: SandpackBundlerFiles) => void;
  isLocalGame: boolean;
  // Sandpack state
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
  showBuildMenu: false,
  setShowBuildMenu: (show) => set({ showBuildMenu: show }),
  showMyGames: false,
  setShowMyGames: (show) => set({ showMyGames: show }),
  // View == play/build states
  gameId: featuredGames[0]?.url ?? "",
  setGameId: (id, files) => {
    const { sandpackClient, iframe, setIframeLoading, setIframeError } = get();
    const isLocalGame = !!files;

    // Clear URL params when resetting
    if (typeof window !== "undefined") {
      window.history.replaceState(
        {
          ...window.history.state,
          as: "/",
          url: "/",
        },
        "",
        "/",
      );
    }

    set({
      gameId: id,
      isLocalGame,
    });

    // If local game, reinitialize sandpack
    if (isLocalGame) {
      if (sandpackClient) {
        sandpackClient.destroy();
        set({ sandpackClient: null });
      }

      void initializeSandpackClient({
        iframe,
        files,
        onClientReady: (client) => {
          set({ sandpackClient: client });
        },
        onLoadingChange: (loading) => {
          setIframeLoading(loading);
        },
        onError: (error) => {
          setIframeError(error);
        },
      });
    }
  },
  gameUrl: null,
  isLocalGame: false,
  // Sandpack state
  sandpackClient: null,
  sandpackFiles: {},
  updateSandpackFiles: (files) => {
    const { sandpackFiles, sandpackClient } = get();
    const newFiles = { ...sandpackFiles, ...files };
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
