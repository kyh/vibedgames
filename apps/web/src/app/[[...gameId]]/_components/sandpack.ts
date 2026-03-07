"use client";

import { loadSandpackClient } from "@codesandbox/sandpack-client";

import type {
  SandpackBundlerFiles,
  SandpackClient,
} from "@codesandbox/sandpack-client";

export const defaultPreviewStyles = `
:root {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.145 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.145 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.985 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.396 0.141 25.723);
  --destructive-foreground: oklch(0.637 0.237 25.331);
  --border: oklch(0.269 0 0);
  --input: oklch(0.269 0 0);
  --ring: oklch(0.439 0 0);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(0.269 0 0);
  --sidebar-ring: oklch(0.439 0 0);
}
 
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
}
 
@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  html, body, #root {
    height: 100%;
  }
}
`;

const defaultTsConfigJson = JSON.stringify(
  {
    include: ["./**/*"],
    compilerOptions: {
      strict: true,
      esModuleInterop: true,
      lib: ["dom", "es2015"],
      jsx: "react-jsx",
    },
  },
  null,
  2,
);

const defaultIndexTsx = `import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

import App from "./App";

const root = createRoot(document.getElementById("root"));
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);`;

const defaultIndexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Document</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const defaultAppTsx = `import { useState } from "react";

function App() {
  return (
    <div className="text-sm grid place-items-center h-full w-full">
      <div className="flex flex-col gap-2 text-center">
        <p className="text-foreground">Build your game with the chat</p>
        <p className="text-muted-foreground">Use "+" command to add specific features</p>
      </div>
    </div>
  );
}

export default App;
`;

export const getDefaultFiles = (): SandpackBundlerFiles => {
  return {
    "/public/index.html": { code: defaultIndexHtml },
    "/App.tsx": { code: defaultAppTsx },
    "/index.tsx": { code: defaultIndexTsx },
    "/styles.css": { code: defaultPreviewStyles },
    "/tsconfig.json": { code: defaultTsConfigJson },
  };
};

type GameBuildFile = {
  path: string;
  content: string;
};

/**
 * Converts an array of game build files to SandpackBundlerFiles format
 */
export function toSandpack(files: GameBuildFile[]): SandpackBundlerFiles {
  return Object.fromEntries(
    files.map((file) => [
      file.path.startsWith("/") ? file.path : `/${file.path}`,
      { code: file.content },
    ]),
  );
}

/**
 * Converts SandpackBundlerFiles to build API format
 */
export function toBuildFiles(
  files: SandpackBundlerFiles,
): { path: string; content: string }[] {
  return Object.entries(files).map(([path, file]) => ({
    path,
    content: file.code,
  }));
}

type InitializeSandpackClientOptions = {
  iframe: HTMLIFrameElement | null;
  files: SandpackBundlerFiles;
  onClientReady: (client: SandpackClient) => void;
  onLoadingChange: (loading: boolean) => void;
  onError: (error: string | null) => void;
  onLog?: (log: string) => void;
};

/**
 * Initializes a Sandpack client with the given files and sets up message listeners
 */
export async function initializeSandpackClient({
  iframe,
  files,
  onClientReady,
  onLoadingChange,
  onError,
  onLog,
}: InitializeSandpackClientOptions): Promise<SandpackClient | null> {
  if (!iframe) return null;

  try {
    onLoadingChange(true);

    const client = await loadSandpackClient(
      iframe,
      {
        files,
        entry: "/index.tsx",
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        template: "create-react-app-typescript",
      },
      {
        externalResources: [
          "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/uicapsule/tailwind.js",
        ],
        showOpenInCodeSandbox: false,
      },
    );

    client.listen((message) => {
      // Log all messages from sandpack (except state messages which are too verbose)
      if (onLog && message.type !== "state") {
        try {
          if (message.type === "console") {
            // Handle console logs
            const consoleMessage = message as {
              type: "console";
              log: { method: string; id: string; data: string[] }[];
            };
            if (Array.isArray(consoleMessage.log)) {
              consoleMessage.log.forEach((logEntry) => {
                const logMethod = logEntry.method || "log";
                const logData = logEntry.data
                  .map((item) => {
                    try {
                      return typeof item === "string"
                        ? item
                        : JSON.stringify(item);
                    } catch {
                      return String(item);
                    }
                  })
                  .join(" ");
                if (logData) {
                  onLog(`[console.${logMethod}] ${logData}`);
                }
              });
            }
          } else {
            // Log all other message types
            const messageStr = JSON.stringify(message, null, 2);
            onLog(`[${message.type}] ${messageStr}`);
          }
        } catch {
          // If logging fails, try to log at least the message type
          onLog(`[${message.type}] (failed to serialize message)`);
        }
      }

      if (message.type === "done") {
        onLoadingChange(false);
        // Check if there was a compilation error
        if (message.compilatonError) {
          onError("Compilation error occurred");
        } else {
          onError(null);
        }
      }
    });

    onClientReady(client);

    return client;
  } catch (error) {
    console.error("Failed to load Sandpack client:", error);
    onError("Failed to initialize Sandpack client");
    return null;
  }
}
