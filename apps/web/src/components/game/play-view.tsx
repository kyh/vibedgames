import { useCallback, useRef, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/input-group";
import { cn } from "@repo/ui/utils";
import { CompassIcon, RefreshCwIcon } from "lucide-react";
import { motion } from "motion/react";

import { Route } from "@/routes/index";

export const PlayView = () => {
  const { game } = Route.useSearch();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    const iframe = iframeRef.current ?? document.querySelector<HTMLIFrameElement>("iframe[title='Game']");
    if (!iframe) return;
    setLoading(true);
    const url = new URL(iframe.src);
    url.searchParams.set("t", Date.now().toString());
    iframe.src = url.toString();
  }, []);

  return (
    <div className="relative pb-4">
      <motion.div
        layoutId="compose-view"
        className="bg-input/40 absolute inset-0 mb-4 rounded-md backdrop-blur-sm"
      />
      <InputGroup className="text-foreground border-none bg-transparent text-sm" asChild>
        <motion.div
          transition={{ type: "spring", bounce: 0.1 }}
          initial={{ opacity: 0, filter: "blur(5px)" }}
          animate={{ opacity: 1, filter: "blur(0px)", transition: { delay: 0.05 } }}
        >
          <InputGroupAddon>
            <InputGroupButton size="icon-xs" asChild>
              <a href={game} target="_blank" rel="noopener noreferrer">
                <CompassIcon />
              </a>
            </InputGroupButton>
          </InputGroupAddon>
          {game && (
            <InputGroupInput
              type="text"
              className="py-2.5 font-mono text-xs md:text-xs"
              onClick={(event) => event.currentTarget.select()}
              value={game}
              readOnly
            />
          )}
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={refresh} type="button" size="icon-xs">
              <RefreshCwIcon className={cn(loading && "animate-spin")} />
            </InputGroupButton>
          </InputGroupAddon>
        </motion.div>
      </InputGroup>
    </div>
  );
};
