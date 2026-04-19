import { useCallback, useEffect, useRef, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/components/input-group";
import { cn } from "@repo/ui/lib/utils";
import { CompassIcon, RefreshCwIcon } from "lucide-react";
import { motion } from "motion/react";

import { Route } from "@/routes/index";
import { gameUrl } from "./data";

export const PlayView = () => {
  const { game } = Route.useSearch();
  const url = gameUrl(game);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loading, setLoading] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const refresh = useCallback(() => {
    const iframe = iframeRef.current ?? document.querySelector<HTMLIFrameElement>("iframe[title='Game']");
    if (!iframe) return;
    setLoading(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setLoading(false), 1500);
    const url = new URL(iframe.src);
    url.searchParams.set("t", Date.now().toString());
    iframe.src = url.toString();
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <div className="relative pb-4">
      <motion.div
        layoutId="compose-view"
        className="bg-input/40 absolute inset-0 mb-4 rounded-md backdrop-blur-sm"
      />
      <motion.div
        transition={{ type: "spring", bounce: 0.1 }}
        initial={{ opacity: 0, filter: "blur(5px)" }}
        animate={{ opacity: 1, filter: "blur(0px)", transition: { delay: 0.05 } }}
      >
        <InputGroup className="text-foreground border-none bg-transparent text-sm">
          <InputGroupAddon>
            <InputGroupButton
              size="icon-xs"
              nativeButton={false}
              render={<a href={url} target="_blank" rel="noopener noreferrer" />}
            >
              <CompassIcon />
            </InputGroupButton>
          </InputGroupAddon>
          {game && (
            <InputGroupInput
              type="text"
              className="py-2.5 font-mono text-xs md:text-xs"
              onClick={(event) => event.currentTarget.select()}
              value={url}
              readOnly
            />
          )}
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={refresh} size="icon-xs">
              <RefreshCwIcon className={cn(loading && "animate-spin")} />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </motion.div>
    </div>
  );
};
