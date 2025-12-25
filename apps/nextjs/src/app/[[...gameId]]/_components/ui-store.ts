"use client";

import type { DataUIPart } from "ai";
import { create } from "zustand";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { featuredGames } from "./data";

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
  setGameId: (id: string | null, files?: Record<string, string>) => void;
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
  sandpackFiles: Record<string, string>;
  updateSandpackFiles: (files: Record<string, string>) => void;
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
    const state = get();
    let newSandpackFiles: Record<string, string>;
    let isLocalGame = false;

    if (id === null) {
      // Null gameId means a brand new local game - use boilerplate
      newSandpackFiles = BOILERPLATE_FILES;
      isLocalGame = true;
    } else if (files !== undefined) {
      // Use provided files (explicit override)
      newSandpackFiles = files;
      isLocalGame = true;
    } else {
      // If files not provided, check if it's a featured game
      const featuredGame = featuredGames.find((g) => g.gameId === id);
      if (featuredGame) {
        if (featuredGame.files) {
          // Local featured game - load its files
          newSandpackFiles = featuredGame.files;
        } else if (featuredGame.url) {
          // Remote featured game - clear files
          newSandpackFiles = {};
        } else {
          // Featured game with no files and no URL (edge case) - keep existing
          newSandpackFiles = state.sandpackFiles;
        }
      } else {
        // Build ID (not in featuredGames) - keep existing files
        newSandpackFiles = state.sandpackFiles;
      }
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
      sandpackFiles: newSandpackFiles,
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
  sandpackFiles: {},
  updateSandpackFiles: (files) =>
    set((state) => ({
      sandpackFiles: { ...state.sandpackFiles, ...files },
    })),
}));

export function useDataStateMapper() {
  const { updateSandpackFiles } = useUiStore();

  return (data: DataUIPart<DataPart>) => {
    switch (data.type) {
      case "data-generating-files":
        if (data.data.files) {
          updateSandpackFiles(data.data.files);
        }
        break;
      default:
        break;
    }
  };
}

// Boilerplate files for new games
const BOILERPLATE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "new-game",
      version: "1.0.0",
      type: "module",
      dependencies: {
        react: "^18.2.0",
        "react-dom": "^18.2.0",
      },
    },
    null,
    2,
  ),
  "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>New Game</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`,
  "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);`,
  "src/App.tsx": `import { useState } from "react";

function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ 
      display: "flex", 
      flexDirection: "column", 
      alignItems: "center", 
      justifyContent: "center", 
      minHeight: "100vh",
      fontFamily: "system-ui, sans-serif",
      background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      color: "white"
    }}>
      <h1 style={{ fontSize: "3rem", marginBottom: "2rem" }}>
        New Game
      </h1>
      <div style={{ 
        background: "rgba(255, 255, 255, 0.2)", 
        padding: "2rem", 
        borderRadius: "1rem",
        backdropFilter: "blur(10px)"
      }}>
        <p style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
          Count: {count}
        </p>
        <button
          onClick={() => setCount(count + 1)}
          style={{
            padding: "0.75rem 1.5rem",
            fontSize: "1rem",
            borderRadius: "0.5rem",
            border: "none",
            background: "white",
            color: "#667eea",
            cursor: "pointer",
            fontWeight: "bold",
          }}
        >
          Click me!
        </button>
      </div>
    </div>
  );
}

export default App;`,
};
