"use client";

import Image from "next/image";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";
import { AnimatePresence, motion } from "motion/react";

import { featuredGames } from "@/app/[[...gameId]]/_components/data";
import { useUiStore } from "@/app/[[...gameId]]/_components/ui-store";

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
    setPreviewIframe,
    refreshPreviewIframe,
    isPreviewIframeLoading,
    setIsPreviewIframeLoading,
    previewIframeError,
    setPreviewIframeError,
    showBuildMenu,
    isLocalGame,
  } = useUiStore();

  // Get current game from gameId
  const currentGame = gameId
    ? featuredGames.find((g) => g.gameId === gameId)
    : null;
  const url = currentGame?.url;

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
              className="h-full w-full"
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
