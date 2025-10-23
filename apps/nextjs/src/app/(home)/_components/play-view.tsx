"use client";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/input-group";
import { cn } from "@repo/ui/utils";
import { CompassIcon, RefreshCwIcon } from "lucide-react";

import { useSandboxStore } from "@/components/chat/chat-state";
import { uiState } from "./ui-state";

export const PlayView = () => {
  const { url } = useSandboxStore();
  const { refreshPreviewIframe, isPreviewIframeLoading } = uiState();

  return (
    <div className="pb-4">
      <InputGroup className="text-foreground w-96 border-none backdrop-blur-sm">
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
      </InputGroup>
    </div>
  );
};
