"use client";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/input-group";
import { cn } from "@repo/ui/utils";
import { CompassIcon, RefreshCwIcon } from "lucide-react";
import { motion } from "motion/react";

import { useUiStore } from "./ui-store";

export const PlayView = () => {
  const { refreshPreviewIframe, isPreviewIframeLoading, previewIframe } =
    useUiStore();

  // Get URL directly from the iframe DOM node
  const displayUrl = previewIframe?.src ?? undefined;

  return (
    <div className="relative pb-4">
      <motion.div
        layoutId="compose-view"
        className="bg-input/40 absolute inset-0 mb-4 rounded-md backdrop-blur-sm"
      />
      <InputGroup
        className="text-foreground border-none bg-transparent text-sm"
        asChild
      >
        <motion.div
          transition={{ type: "spring", bounce: 0.1 }}
          initial={{ opacity: 0, filter: "blur(5px)" }}
          animate={{
            opacity: 1,
            filter: "blur(0px)",
            transition: { delay: 0.05 },
          }}
        >
          <InputGroupAddon>
            <InputGroupButton size="icon-xs" asChild>
              <a href={displayUrl} target="_blank" rel="noopener noreferrer">
                <CompassIcon />
              </a>
            </InputGroupButton>
          </InputGroupAddon>
          {displayUrl && (
            <InputGroupInput
              type="text"
              className="py-2.5 font-mono text-xs md:text-xs"
              onClick={(event) => event.currentTarget.select()}
              value={displayUrl}
              readOnly
            />
          )}
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              onClick={refreshPreviewIframe}
              type="button"
              size="icon-xs"
            >
              <RefreshCwIcon
                className={cn(isPreviewIframeLoading && "animate-spin")}
              />
            </InputGroupButton>
          </InputGroupAddon>
        </motion.div>
      </InputGroup>
    </div>
  );
};
