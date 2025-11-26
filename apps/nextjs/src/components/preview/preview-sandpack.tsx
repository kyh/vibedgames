"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SandpackClient } from "@codesandbox/sandpack-client";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";

const DEFAULT_ENTRY_POINTS = [
  "/index.html",
  "/src/index.tsx",
  "/src/main.tsx",
  "/src/index.ts",
  "/src/main.ts",
  "/src/index.js",
  "/src/main.js",
];

type Props = {
  className?: string;
  files: Record<string, string>;
};

function toSandpackFiles(files: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(files).map(([path, code]) => [
      path.startsWith("/") ? path : `/${path}`,
      { code },
    ]),
  );
}

function resolveEntry(files: Record<string, string>) {
  const normalized = Object.keys(files).map((path) =>
    path.startsWith("/") ? path : `/${path}`,
  );

  return (
    DEFAULT_ENTRY_POINTS.find((candidate) => normalized.includes(candidate)) ??
    normalized[0] ??
    "/index.html"
  );
}

export const PreviewSandpack = ({ files, className }: Props) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const clientRef = useRef<SandpackClient | null>(null);
  const [isBundlerBooting, setIsBundlerBooting] = useState(false);

  const hasFiles = useMemo(() => Object.keys(files).length > 0, [files]);
  const isBooting = hasFiles && isBundlerBooting;

  useEffect(() => {
    return () => clientRef.current?.destroy();
  }, []);

  useEffect(() => {
    if (!iframeRef.current) return;

    if (clientRef.current) {
      clientRef.current.destroy();
    }

    if (!hasFiles) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsBundlerBooting(true);
    const client = new SandpackClient(
      iframeRef.current,
      {
        files: toSandpackFiles(files),
        template: "static",
        entry: resolveEntry(files),
      },
      {
        showOpenInCodeSandbox: false,
      },
    );

    clientRef.current = client;

    const unsubscribe = client.listen((message) => {
      if (message.type === "status" && message.status === "running") {
        setIsBundlerBooting(false);
      }
    });

    return () => {
      unsubscribe();
      client.destroy();
    };
  }, [files, hasFiles]);

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden rounded-xl border bg-black/80",
        className,
      )}
    >
      <iframe
        ref={iframeRef}
        title="Game preview"
        className="h-full w-full"
        sandbox="allow-scripts allow-same-origin allow-forms"
      />

      {!hasFiles && (
        <div className="absolute inset-0 grid place-items-center text-sm text-gray-300">
          Generate a game to see the live preview here.
        </div>
      )}

      {isBooting && (
        <div className="absolute inset-0 grid place-items-center bg-black/60 text-sm text-gray-200">
          <div className="flex items-center gap-2">
            <Spinner />
            <span>Booting Sandpack preview…</span>
          </div>
        </div>
      )}
    </div>
  );
};
