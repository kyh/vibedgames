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
  // View == discover state
  hoverGameIndex: number | null;
  setHoverGameIndex: (index: number) => void;
  // View == build states
  showFileExplorer: boolean;
  setShowFileExplorer: (show: boolean) => void;
  showBuildMenu: boolean;
  setShowBuildMenu: (show: boolean) => void;
  showMyGames: boolean;
  setShowMyGames: (show: boolean) => void;
  // View == play/build states
  gameId: string | null;
  setGameId: (id: string | null, files?: SandpackBundlerFiles) => void;
  isLocalGame: boolean;
  // Sandpack state
  sandpackFiles: SandpackBundlerFiles;
  updateSandpackFiles: (files: SandpackBundlerFiles) => void;
  sandpackClient: SandpackClient | null;
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
  // View == discover state
  hoverGameIndex: null,
  setHoverGameIndex: (index) => set({ hoverGameIndex: index }),
  // View == build states
  showFileExplorer: false,
  setShowFileExplorer: (show) => set({ showFileExplorer: show }),
  showBuildMenu: false,
  setShowBuildMenu: (show) => set({ showBuildMenu: show }),
  showMyGames: false,
  setShowMyGames: (show) => set({ showMyGames: show }),
  // View == play/build states
  gameId: featuredGames[0]?.gameId ?? null,
  setGameId: (id, files) => {
    const isLocalGame = id === null || files !== undefined;
    let sandpackFiles: SandpackBundlerFiles;
    console.log("setGameId", id, files, isLocalGame);
    const sandpackClient = get().sandpackClient;
    if (sandpackClient) {
      sandpackClient.destroy();
      set({ sandpackClient: null });
    }

    if (isLocalGame) {
      const iframe = get().previewIframe;
      if (files !== undefined) {
        sandpackFiles = files;
      } else {
        sandpackFiles = getDefaultFiles();
      }

      void initSandpackClient({
        iframe,
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
