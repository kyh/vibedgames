import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@repo/ui/components/sonner";

const SUCCESS_TOAST = "Copied. Paste it into Claude, Cursor, or Codex.";
const ERROR_TOAST = "Failed to copy.";
const RESET_MS = 2000;

export const useCopyToClipboard = () => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(SUCCESS_TOAST);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), RESET_MS);
    } catch {
      toast.error(ERROR_TOAST);
    }
  }, []);

  return { copied, copy };
};
