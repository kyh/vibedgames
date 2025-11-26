"use client";

import { useCallback, useEffect, useRef } from "react";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCwIcon } from "lucide-react";

import { useSandpackStore } from "./sandpack-store";

type Props = {
  className?: string;
  disabled?: boolean;
};

export const SandpackPreview = ({ className, disabled }: Props) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { initialize, isLoading, isReady, error, refresh, files } =
    useSandpackStore();

  // Initialize sandpack when iframe is available and we have files
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe && !disabled) {
      void initialize(iframe);
    }
  }, [initialize, disabled, files]);

  const handleRetry = useCallback(() => {
    const iframe = iframeRef.current;
    if (iframe) {
      void initialize(iframe);
    }
  }, [initialize]);

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-clip rounded-xl bg-[#1a1a2e]",
        className,
      )}
    >
      <AnimatePresence mode="wait">
        {disabled ? (
          <motion.div
            key="disabled"
            className="flex h-full w-full items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <p className="text-gray-500">Preview disabled</p>
          </motion.div>
        ) : error ? (
          <motion.div
            key="error"
            className="flex h-full w-full flex-col items-center justify-center gap-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <p className="text-sm text-red-400">{error}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRetry}
            >
              <RefreshCwIcon className="mr-2 h-4 w-4" />
              Try again
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="preview"
            className="relative h-full w-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <iframe
              ref={iframeRef}
              className="h-full w-full border-0"
              title="Game Preview"
              sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
            />

            {/* Loading overlay */}
            {isLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#1a1a2e]/80 backdrop-blur-sm">
                <Spinner />
                <span className="text-xs text-gray-400">
                  Initializing sandbox...
                </span>
              </div>
            )}

            {/* Refresh button */}
            {isReady && (
              <motion.button
                className="absolute right-3 top-3 rounded-md bg-black/50 p-2 text-white/70 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white"
                onClick={refresh}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                title="Refresh preview"
              >
                <RefreshCwIcon className="h-4 w-4" />
              </motion.button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
