"use client";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/input-group";
import { CompassIcon, RefreshCwIcon } from "lucide-react";

import { useSandboxStore } from "@/components/chat/state";

export const PlayView = () => {
  const { url } = useSandboxStore();

  const refreshIframe = () => {
    if (!url) return;
    const newUrl = new URL(url);
    newUrl.searchParams.set("t", Date.now().toString());
    const iframe = document.getElementById(
      "preview-iframe",
    ) as HTMLIFrameElement | null;
    if (iframe) iframe.src = newUrl.toString();
  };

  return (
    <div>
      <InputGroup className="w-96 border-none backdrop-blur-sm">
        <InputGroupAddon>
          <a href={url} target="_blank" className="cursor-pointer">
            <CompassIcon className="text-foreground w-4" />
          </a>
        </InputGroupAddon>
        {url && (
          <InputGroupInput
            type="text"
            className="font-mono text-xs"
            onClick={(event) => event.currentTarget.select()}
            value={url}
            readOnly
          />
        )}
        <InputGroupAddon align="inline-end">
          <InputGroupButton onClick={refreshIframe} type="button">
            <RefreshCwIcon className={"text-foreground w-4"} />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
};
