"use client";

import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";

import { uiState } from "@/app/(home)/_components/ui-state";

type Props = {
  className?: string;
  showHeader?: boolean;
  disabled?: boolean;
  url?: string;
  renderThumbnail?: (url?: string, disabled?: boolean) => React.ReactNode;
};

export const PreviewWeb = ({
  className,
  disabled,
  url,
  renderThumbnail,
}: Props) => {
  const {
    setPreviewIframe,
    refreshPreviewIframe,
    isPreviewIframeLoading,
    setIsPreviewIframeLoading,
    previewIframeError,
    setPreviewIframeError,
  } = uiState();

  const handleIframeLoad = () => {
    setIsPreviewIframeLoading(false);
    setPreviewIframeError(null);
  };

  const handleIframeError = () => {
    setIsPreviewIframeLoading(false);
    setPreviewIframeError("Failed to load the page");
  };

  return (
    <div className={cn("relative h-full w-full overflow-clip", className)}>
      {renderThumbnail?.(url, disabled)}
      {url && !disabled && (
        <>
          <iframe
            ref={setPreviewIframe}
            src={url}
            className="relative h-full w-full"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            title="Browser content"
            allow="camera; microphone"
          />
          {isPreviewIframeLoading && !previewIframeError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Spinner />
              <span className="text-xs text-gray-500">Loading...</span>
            </div>
          )}
          {previewIframeError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <p>Failed to load page</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={refreshPreviewIframe}
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
