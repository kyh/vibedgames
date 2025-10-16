"use client";

import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@radix-ui/react-scroll-area";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";
import { CompassIcon, RefreshCwIcon } from "lucide-react";

type Props = {
  className?: string;
  disabled?: boolean;
  url?: string;
};

export const Preview = ({ className, disabled, url }: Props) => {
  const [currentUrl, setCurrentUrl] = useState(url);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(url || "");
  const [isLoading, setIsLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadStartTime = useRef<number | null>(null);

  useEffect(() => {
    setCurrentUrl(url);
    setInputValue(url || "");
  }, [url]);

  const refreshIframe = () => {
    if (iframeRef.current && currentUrl) {
      setIsLoading(true);
      setError(null);
      loadStartTime.current = Date.now();
      iframeRef.current.src = "";
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = currentUrl;
        }
      }, 10);
    }
  };

  const loadNewUrl = () => {
    if (iframeRef.current && inputValue) {
      if (inputValue !== currentUrl) {
        setIsLoading(true);
        setError(null);
        loadStartTime.current = Date.now();
        iframeRef.current.src = inputValue;
      } else {
        refreshIframe();
      }
    }
  };

  const handleIframeLoad = () => {
    setIsLoading(false);
    setError(null);
  };

  const handleIframeError = () => {
    setIsLoading(false);
    setError("Failed to load the page");
  };

  return (
    <div className={className}>
      <div>
        <div className="absolute flex items-center space-x-1">
          <a href={currentUrl} target="_blank" className="cursor-pointer px-1">
            <CompassIcon className="w-4" />
          </a>
          <button
            onClick={refreshIframe}
            type="button"
            className={cn("cursor-pointer px-1", {
              "animate-spin": isLoading,
            })}
          >
            <RefreshCwIcon className="w-4" />
          </button>
        </div>

        <div className="m-auto h-6">
          {url && (
            <input
              type="text"
              className="h-6 min-w-[300px] rounded border border-gray-200 bg-white px-4 font-mono text-xs focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
              onChange={(event) => setInputValue(event.target.value)}
              onClick={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                  loadNewUrl();
                }
              }}
              value={inputValue}
            />
          )}
        </div>
      </div>

      <div className="relative flex h-[calc(100%-2rem-1px)]">
        {currentUrl && !disabled && (
          <>
            <ScrollArea className="w-full">
              <iframe
                ref={iframeRef}
                src={currentUrl}
                className="h-full w-full"
                onLoad={handleIframeLoad}
                onError={handleIframeError}
                title="Browser content"
              />
            </ScrollArea>

            {isLoading && !error && (
              <div className="bg-opacity-90 absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white">
                <Spinner />
                <span className="text-xs text-gray-500">Loading...</span>
              </div>
            )}

            {error && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white">
                <span className="text-red-500">Failed to load page</span>
                <button
                  className="text-sm text-blue-500 hover:underline"
                  type="button"
                  onClick={() => {
                    if (currentUrl) {
                      setIsLoading(true);
                      setError(null);
                      const newUrl = new URL(currentUrl);
                      newUrl.searchParams.set("t", Date.now().toString());
                      setCurrentUrl(newUrl.toString());
                    }
                  }}
                >
                  Try again
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
