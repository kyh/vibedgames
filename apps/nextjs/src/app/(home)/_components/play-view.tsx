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

import { useSandboxStore } from "@/components/chat/chat-state";
import { uiState } from "./ui-state";

export const PlayView = () => {
  const { url } = useSandboxStore();
  const { refreshPreviewIframe, isPreviewIframeLoading } = uiState();

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
          initial={{ scale: 0.9, opacity: 0, filter: "blur(5px)" }}
          animate={{
            scale: 1,
            opacity: 1,
            filter: "blur(0px)",
            transition: { delay: 0.05 },
          }}
        >
          <InputGroupAddon>
            <InputGroupButton size="icon-xs" asChild>
              <a href={url} target="_blank">
                <CompassIcon />
              </a>
            </InputGroupButton>
          </InputGroupAddon>
          {url && (
            <InputGroupInput
              type="text"
              className="py-2.5 font-mono text-xs md:text-xs"
              onClick={(event) => event.currentTarget.select()}
              value={url}
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
