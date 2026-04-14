import { useEffect, useState } from "react";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";

type Props = {
  url?: string;
};

export const Iframe = ({ url }: Props) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reset loading state when URL changes
  useEffect(() => {
    setLoading(true);
    setError(null);
  }, [url]);

  return (
    <>
      <iframe
        key={url}
        src={url}
        className="h-full w-full"
        onLoad={() => { setLoading(false); setError(null); }}
        onError={() => { setLoading(false); setError("Failed to load the page"); }}
        title="Game"
        allow="camera; microphone"
      />
      {loading && !error && (
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
            onClick={() => { setLoading(true); setError(null); }}
          >
            Try again
          </Button>
        </div>
      )}
    </>
  );
};
