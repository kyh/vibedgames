"use client";

import type { DataUIPart } from "ai";
import { create } from "zustand";

import type {
  SandpackBundlerFiles,
  SandpackClient,
} from "@codesandbox/sandpack-client";
import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { featuredGames } from "./data";
import {
  getDefaultFiles,
  initializeSandpackClient as initSandpackClient,
  toSandpack,
} from "./sandpack";

type View = "build" | "play" | "discover";

type UIState = {
  // General view state
  view: View;
  setView: (view: View) => void;
  previewIframe: HTMLIFrameElement | null;
  setPreviewIframe: (iframe: HTMLIFrameElement | null) => void;
  refreshPreviewIframe: () => void;
  isPreviewIframeLoading: boolean;
  setIsPreviewIframeLoading: (loading: boolean) => void;
  previewIframeError: string | null;
  setPreviewIframeError: (error: string | null) => void;
  // Preview stack state
  gameId: string | null;
  setGameId: (id: string | null, files?: SandpackBundlerFiles) => void;
  isLocalGame: boolean;
  isMobile: boolean;
  // Build view state
  showFileExplorer: boolean;
  setShowFileExplorer: (show: boolean) => void;
  showBuildMenu: boolean;
  setShowBuildMenu: (show: boolean) => void;
  showMyGames: boolean;
  setShowMyGames: (show: boolean) => void;
  // Sandpack state
  sandpackFiles: SandpackBundlerFiles;
  updateSandpackFiles: (files: SandpackBundlerFiles) => void;
  sandpackClient: SandpackClient | null;
};

// Helper function to check if mobile on initialization
const getInitialIsMobile = () => {
  if (typeof window === "undefined") return false;
  return window.innerWidth <= 640;
};

export const useUiStore = create<UIState>((set, get) => ({
  view: "play",
  setView: (view) => set({ view }),
  previewIframe: null,
  setPreviewIframe: (iframe) => set({ previewIframe: iframe }),
  refreshPreviewIframe: () => {
    const previewIframe = get().previewIframe;
    if (!previewIframe) return;

    // Set loading state and clear any errors
    set({ isPreviewIframeLoading: true, previewIframeError: null });

    const newUrl = new URL(previewIframe.src);
    newUrl.searchParams.set("t", Date.now().toString());
    previewIframe.src = newUrl.toString();
  },
  isPreviewIframeLoading: false,
  setIsPreviewIframeLoading: (loading) =>
    set({ isPreviewIframeLoading: loading }),
  previewIframeError: null,
  setPreviewIframeError: (error) => set({ previewIframeError: error }),
  // Preview stack state
  gameId: featuredGames[0]?.gameId ?? null,
  setGameId: (id, files) => {
    const isLocalGame = id === null || files !== undefined;
    let sandpackFiles: SandpackBundlerFiles;

    const sandpackClient = get().sandpackClient;
    if (sandpackClient) {
      sandpackClient.destroy();
      set({ sandpackClient: null });
    }

    if (isLocalGame) {
      if (files !== undefined) {
        sandpackFiles = files;
      } else {
        sandpackFiles = getDefaultFiles();
      }

      void initSandpackClient({
        iframe: get().previewIframe,
        files: sandpackFiles,
        onClientReady: (client) => {
          set({ sandpackClient: client });
        },
        onLoadingChange: (loading) => {
          get().setIsPreviewIframeLoading(loading);
        },
        onError: (error) => {
          get().setPreviewIframeError(error);
        },
      });
    } else {
      sandpackFiles = {};
    }

    // Clear URL params when resetting
    if (id === null && typeof window !== "undefined") {
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
      sandpackFiles,
      isLocalGame,
    });
  },
  isLocalGame: false,
  isMobile: getInitialIsMobile(),
  // Build view state
  showFileExplorer: false,
  setShowFileExplorer: (show) => set({ showFileExplorer: show }),
  showBuildMenu: false,
  setShowBuildMenu: (show) => set({ showBuildMenu: show }),
  showMyGames: false,
  setShowMyGames: (show) => set({ showMyGames: show }),
  // Sandpack state
  sandpackClient: null,
  sandpackFiles: {},
  updateSandpackFiles: (files) =>
    set((state) => {
      const newFiles = { ...state.sandpackFiles, ...files };

      return {
        sandpackFiles: newFiles,
      };
    }),
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
