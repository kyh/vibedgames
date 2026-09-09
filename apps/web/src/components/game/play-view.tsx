import { useCallback, useEffect, useRef, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/components/input-group";
import { cn } from "cn";
import { CompassIcon, RefreshCwIcon } from "lucide-react";
import { motion } from "motion/react";
import { getRouteApi } from "@tanstack/react-router";

import { FadeInBlur } from "@/components/ui/fade-in-blur";
import { gameUrl } from "./data";

const route = getRouteApi("/_site/");

export const PlayView = () => {
  const { game } = route.useSearch();
  const url = gameUrl(game);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loading, setLoading] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const refresh = useCallback(() => {
    const iframe =
      iframeRef.current ?? document.querySelector<HTMLIFrameElement>("iframe[title='Game']");
    if (!iframe) {
      return;
    }
    setLoading(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setLoading(false), 1500);
    const src = new URL(iframe.src);
    src.searchParams.set("t", Date.now().toString());
    iframe.src = src.toString();
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return (
    <div className="relative">
      <motion.div
        layoutId="compose-view"
        className="bg-input/40 absolute inset-0 rounded-md backdrop-blur-sm"
      />
      <FadeInBlur>
        <InputGroup className="text-foreground border-none bg-transparent text-sm">
          <InputGroupAddon>
            <InputGroupButton
              size="icon-xs"
              nativeButton={false}
              render={
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open game in new tab"
                />
              }
            >
              <CompassIcon />
            </InputGroupButton>
          </InputGroupAddon>
          {game && (
            <InputGroupInput
              type="text"
              className="py-2.5 font-mono text-xs sm:text-xs"
              onClick={(event) => event.currentTarget.select()}
              value={url}
              readOnly
            />
          )}
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={refresh} size="icon-xs" aria-label="Refresh game">
              <RefreshCwIcon className={cn(loading && "animate-spin")} />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </FadeInBlur>
    </div>
  );
};
