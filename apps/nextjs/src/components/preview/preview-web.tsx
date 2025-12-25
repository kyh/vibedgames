"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { loadSandpackClient } from "@codesandbox/sandpack-client";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";
import { AnimatePresence, motion } from "motion/react";

import type { SandpackClient } from "@codesandbox/sandpack-client";
import { featuredGames } from "@/app/[[...gameId]]/_components/data";
import { useUiStore } from "@/app/[[...gameId]]/_components/ui-store";

function toSandpackFiles(files: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(files).map(([path, code]) => [
      path.startsWith("/") ? path : `/${path}`,
      { code },
    ]),
  );
}

type Props = {
  className?: string;
  showHeader?: boolean;
  disabled?: boolean;
  name?: string;
  preview?: string;
  onPreviewClick?: () => void;
};

export const PreviewWeb = ({
  className,
  disabled,
  preview,
  name,
  onPreviewClick,
}: Props) => {
  const {
    gameId,
    sandpackFiles,
    setPreviewIframe,
    refreshPreviewIframe,
    isPreviewIframeLoading,
    setIsPreviewIframeLoading,
    previewIframeError,
    setPreviewIframeError,
    showBuildMenu,
    previewIframe,
    isLocalGame,
  } = useUiStore();

  const clientRef = useRef<SandpackClient | null>(null);

  // Get current game from gameId
  const currentGame = gameId
    ? featuredGames.find((g) => g.gameId === gameId)
    : null;
  const url = currentGame?.url;

  // Initialize sandpack client for local games
  useEffect(() => {
    if (!isLocalGame) return;
    if (!previewIframe) return;

    // Clean up previous client if it exists
    if (clientRef.current) {
      clientRef.current.destroy();
      clientRef.current = null;
    }

    const initClient = async () => {
      try {
        const client = await loadSandpackClient(
          previewIframe,
          {
            files: toSandpackFiles(sandpackFiles),
            template: "create-react-app-typescript",
          },
          {
            showOpenInCodeSandbox: false,
          },
        );

        clientRef.current = client;

        client.listen((message) => {
          console.log("message", message);
          if (message.type === "done") {
            setIsPreviewIframeLoading(false);
            // Check if there was a compilation error
            if (message.compilatonError) {
              setPreviewIframeError("Compilation error occurred");
            } else {
              setPreviewIframeError(null);
            }
          } else if (
            message.type === "action" &&
            message.action === "show-error"
          ) {
            // Handle sandpack error message
            setIsPreviewIframeLoading(false);
            setPreviewIframeError(message.message || message.title);
          } else if (
            message.type === "action" &&
            message.action === "notification" &&
            message.notificationType === "error"
          ) {
            // Handle error notification
            setIsPreviewIframeLoading(false);
            setPreviewIframeError(message.title);
          }
        });
      } catch (error) {
        console.error("Failed to load Sandpack client:", error);
      }
    };

    void initClient();
  }, [
    isLocalGame,
    previewIframe,
    sandpackFiles,
    setIsPreviewIframeLoading,
    setPreviewIframeError,
  ]);

  useEffect(() => {
    return () => {
      clientRef.current?.destroy();
    };
  }, []);

  const handleIframeLoad = () => {
    setIsPreviewIframeLoading(false);
    setPreviewIframeError(null);
  };

  const handleIframeError = () => {
    setIsPreviewIframeLoading(false);
    setPreviewIframeError("Failed to load the page");
  };

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-clip",
        showBuildMenu && "pointer-events-none",
        className,
      )}
    >
      <AnimatePresence>
        {(!url || disabled) && preview && (
          <motion.button
            key="preview-image"
            className="absolute inset-0 overflow-clip rounded-xl shadow-lg"
            onClick={onPreviewClick}
            initial={{ opacity: 0, filter: "blur(5px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(5px)" }}
            transition={{ duration: 0.2 }}
          >
            <Image
              className="object-cover"
              src={preview}
              alt={name ?? "Preview"}
              fill
            />
          </motion.button>
        )}
        {((url && !disabled) || isLocalGame) && (
          <motion.div key="preview-iframe" className="relative h-full w-full">
            <motion.iframe
              ref={setPreviewIframe}
              src={!isLocalGame ? url : undefined}
              className="relative h-full w-full"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
              title="Game preview"
              allow="camera; microphone"
              initial={{ opacity: 0, filter: "blur(5px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(5px)" }}
              transition={{ duration: 0.2 }}
            />
            {isPreviewIframeLoading && !previewIframeError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <Spinner />
                <span className="text-xs text-gray-500">Loading...</span>
              </div>
            )}
            {previewIframeError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <p>Failed to load page</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={refreshPreviewIframe}
                >
                  Try again
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
