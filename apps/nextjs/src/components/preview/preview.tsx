"use client";

import { useRef, useState } from "react";
import { ScrollArea } from "@radix-ui/react-scroll-area";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/input-group";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";
import { CompassIcon, RefreshCwIcon } from "lucide-react";

type Props = {
  className?: string;
  showHeader?: boolean;
  disabled?: boolean;
  url?: string;
  preview?: React.ReactNode;
};

export const Preview = ({
  className,
  showHeader,
  disabled,
  url,
  preview,
}: Props) => {
  const [currentUrl, setCurrentUrl] = useState(url);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(url ?? "");
  const [isLoading, setIsLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadStartTime = useRef<number | null>(null);

  // Update state when url prop changes
  const currentUrlValue = url ?? currentUrl;
  const inputValueValue = url ?? inputValue;

  const refreshIframe = () => {
    if (iframeRef.current && currentUrlValue) {
      setIsLoading(true);
      setError(null);
      loadStartTime.current = Date.now();
      iframeRef.current.src = "";
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = currentUrlValue;
        }
      }, 10);
    }
  };

  const loadNewUrl = () => {
    if (iframeRef.current && inputValueValue) {
      if (inputValueValue !== currentUrlValue) {
        setIsLoading(true);
        setError(null);
        loadStartTime.current = Date.now();
        iframeRef.current.src = inputValueValue;
        setCurrentUrl(inputValueValue);
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
    <div className={cn("relative h-full w-full", className)}>
      {showHeader && (
        <header className="absolute top-4 left-1/2 z-10 -translate-x-1/2">
          <InputGroup className="w-96 border-none backdrop-blur-sm">
            <InputGroupAddon>
              <a
                href={currentUrlValue}
                target="_blank"
                className="cursor-pointer"
              >
                <CompassIcon className="w-4" />
              </a>
            </InputGroupAddon>
            {url && (
              <InputGroupInput
                type="text"
                className="font-mono text-xs"
                onChange={(event) => setInputValue(event.target.value)}
                onClick={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                    loadNewUrl();
                  }
                }}
                value={inputValueValue}
                readOnly
              />
            )}
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                onClick={refreshIframe}
                type="button"
                className={cn({
                  "animate-spin": isLoading,
                })}
              >
                <RefreshCwIcon className="w-4" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </header>
      )}
      <div className="relative flex h-full">
        {preview && preview}
        {currentUrlValue && !disabled && (
          <>
            <ScrollArea className="w-full">
              <iframe
                ref={iframeRef}
                src={currentUrlValue}
                className="h-full w-full"
                onLoad={handleIframeLoad}
                onError={handleIframeError}
                title="Browser content"
                allow="camera; microphone"
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
                    if (currentUrlValue) {
                      setIsLoading(true);
                      setError(null);
                      const newUrl = new URL(currentUrlValue);
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
