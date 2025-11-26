"use client";

import type { ChatStatus, DataUIPart } from "ai";
import type {
  SandpackClient,
  SandpackBundlerFiles,
} from "@codesandbox/sandpack-client";
import { loadSandpackClient } from "@codesandbox/sandpack-client";
import { create } from "zustand";

import type { DataPart } from "@repo/api/agent/messages/data-parts";

// Default template for a React project (CRA-compatible)
const DEFAULT_TEMPLATE: SandpackBundlerFiles = {
  "/package.json": {
    code: JSON.stringify(
      {
        name: "game",
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
        },
      },
      null,
      2,
    ),
  },
  "/public/index.html": {
    code: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Game</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
  },
  "/src/index.js": {
    code: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
  },
  "/src/App.js": {
    code: `export default function App() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#1a1a2e' }}>
      <h1 style={{ color: 'white', fontFamily: 'system-ui' }}>Loading game...</h1>
    </div>
  );
}
`,
  },
};

export type SandpackStoreState = {
  // Sandpack client instance
  client: SandpackClient | null;
  // Files in the sandpack
  files: SandpackBundlerFiles;
  // Preview iframe element
  previewIframe: HTMLIFrameElement | null;
  // Loading/status
  isLoading: boolean;
  isReady: boolean;
  error: string | null;
  // Chat status
  chatStatus: ChatStatus;
  // Generated file paths for UI display
  generatedFiles: Set<string>;
  // Project metadata
  projectId?: string;
  buildNumber?: number;
};

export type SandpackStoreActions = {
  // Initialize the sandpack client with an iframe
  initialize: (iframe: HTMLIFrameElement) => Promise<void>;
  // Update files in the sandpack
  updateFiles: (files: { path: string; content: string }[]) => void;
  // Reset to initial state
  reset: () => void;
  // Set chat status
  setChatStatus: (status: ChatStatus) => void;
  // Set project metadata
  setProjectMetadata: (projectId: string, buildNumber?: number) => void;
  // Add generated file paths
  addGeneratedFiles: (paths: string[]) => void;
  // Clear generated files
  clearGeneratedFiles: () => void;
  // Refresh the preview
  refresh: () => void;
};

type SandpackStore = SandpackStoreState & SandpackStoreActions;

export const useSandpackStore = create<SandpackStore>()((set, get) => ({
  // Initial state
  client: null,
  files: { ...DEFAULT_TEMPLATE },
  previewIframe: null,
  isLoading: false,
  isReady: false,
  error: null,
  chatStatus: "ready",
  generatedFiles: new Set<string>(),
  projectId: undefined,
  buildNumber: undefined,

  initialize: async (iframe: HTMLIFrameElement) => {
    const state = get();

    // If already initialized with this iframe, skip
    if (state.client && state.previewIframe === iframe) {
      return;
    }

    // Cleanup existing client
    if (state.client) {
      state.client.destroy();
    }

    set({ isLoading: true, error: null, previewIframe: iframe });

    try {
      const client = await loadSandpackClient(iframe, {
        files: state.files,
        // Let sandpack infer the template from package.json
      });

      set({
        client,
        isLoading: false,
        isReady: true,
        error: null,
      });
    } catch (err) {
      set({
        isLoading: false,
        isReady: false,
        error: err instanceof Error ? err.message : "Failed to initialize",
      });
    }
  },

  updateFiles: (files: { path: string; content: string }[]) => {
    const state = get();

    // Convert files to sandpack format
    const newFiles: SandpackBundlerFiles = { ...state.files };
    for (const file of files) {
      // Ensure path starts with /
      const path = file.path.startsWith("/") ? file.path : `/${file.path}`;
      newFiles[path] = { code: file.content };
    }

    set({ files: newFiles });

    // Update client if it exists
    if (state.client) {
      try {
        state.client.updateSandbox({
          files: newFiles,
        });
      } catch (err) {
        console.error("Failed to update sandpack files:", err);
      }
    }
  },

  reset: () => {
    const state = get();

    // Destroy existing client
    if (state.client) {
      state.client.destroy();
    }

    set({
      client: null,
      files: { ...DEFAULT_TEMPLATE },
      previewIframe: null,
      isLoading: false,
      isReady: false,
      error: null,
      generatedFiles: new Set<string>(),
      projectId: undefined,
      buildNumber: undefined,
    });
  },

  setChatStatus: (status) =>
    set((state) =>
      state.chatStatus === status ? state : { chatStatus: status },
    ),

  setProjectMetadata: (projectId, buildNumber) =>
    set({ projectId, buildNumber }),

  addGeneratedFiles: (paths) =>
    set((state) => ({
      generatedFiles: new Set([...state.generatedFiles, ...paths]),
    })),

  clearGeneratedFiles: () => set({ generatedFiles: new Set<string>() }),

  refresh: () => {
    const state = get();
    if (state.client) {
      state.client.dispatch({ type: "refresh" });
    }
  },
}));

/**
 * Hook to map data parts from AI stream to sandpack store actions
 */
export function useSandpackDataMapper() {
  const { updateFiles, setProjectMetadata, addGeneratedFiles } =
    useSandpackStore();

  return (data: DataUIPart<DataPart>) => {
    switch (data.type) {
      case "data-generating-files":
        if (data.data.status === "done" && data.data.paths.length > 0) {
          addGeneratedFiles(data.data.paths);
        }
        break;
      case "data-file-content":
        // Stream file contents to sandpack
        if (data.data.files.length > 0) {
          updateFiles(data.data.files);
        }
        break;
      case "data-project-metadata":
        // Update project metadata
        if (data.data.projectId) {
          setProjectMetadata(data.data.projectId, data.data.buildNumber);
        }
        break;
      default:
        break;
    }
  };
}

/**
 * Get file paths from the sandpack store
 */
export function useSandpackFilePaths() {
  const files = useSandpackStore((state) => state.files);
  return Object.keys(files)
    .filter((path) => path !== "/package.json")
    .map((path) => (path.startsWith("/") ? path.slice(1) : path));
}
