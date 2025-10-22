"use client";

import { useRef, useState } from "react";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";

type Props = {
  className?: string;
  showHeader?: boolean;
  disabled?: boolean;
  url?: string;
  preview?: React.ReactNode;
};

export const Preview = ({ className, disabled, url, preview }: Props) => {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
      {preview && preview}
      {url && !disabled && (
        <>
          <iframe
            id="preview-iframe"
            ref={iframeRef}
            src={url}
            className="relative h-full w-full"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            title="Browser content"
            allow="camera; microphone"
          />
          {isLoading && !error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Spinner />
              <span className="text-xs text-gray-500">Loading...</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <p>Failed to load page</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (url) {
                    setIsLoading(true);
                    setError(null);
                    const newUrl = new URL(url);
                    newUrl.searchParams.set("t", Date.now().toString());
                    if (iframeRef.current) {
                      iframeRef.current.src = newUrl.toString();
                    }
                  }
                }}
              >
                Try again
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
