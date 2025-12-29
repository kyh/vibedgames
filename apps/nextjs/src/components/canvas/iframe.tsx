"use client";

import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";

import { useUiStore } from "@/app/[[...gameId]]/_components/ui-store";

type Props = {
  url?: string;
  className?: string;
};

export const Iframe = ({ url }: Props) => {
  const {
    setIframe,
    refreshIframe,
    iframeLoading,
    setIframeLoading,
    iframeError,
    setIframeError,
  } = useUiStore();

  const handleIframeLoad = () => {
    setIframeLoading(false);
    setIframeError(null);
  };

  const handleIframeError = () => {
    setIframeLoading(false);
    setIframeError("Failed to load the page");
  };

  return (
    <>
      <iframe
        ref={setIframe}
        src={url}
        className="h-full w-full"
        onLoad={handleIframeLoad}
        onError={handleIframeError}
        title="Game"
        allow="camera; microphone"
      />
      {iframeLoading && !iframeError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <Spinner />
          <span className="text-xs text-gray-500">Loading...</span>
        </div>
      )}
      {iframeError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <p>Failed to load page</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={refreshIframe}
          >
            Try again
          </Button>
        </div>
      )}
    </>
  );
};
