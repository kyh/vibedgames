import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";

import { useTRPC } from "@/lib/trpc";

type CliAuthConfirmProps = {
  code: string;
  userName: string;
};

export const CliAuthConfirm = ({ code, userName }: CliAuthConfirmProps) => {
  const trpc = useTRPC();
  const confirm = useMutation(trpc.auth.cliConfirm.mutationOptions());

  // Auto-confirm on mount: reaching this page is the authorization. The loader
  // already gated on an authenticated session (redirecting to login otherwise),
  // so the logged-in user landing here is the consent — no manual code match.
  // The ref guard keeps the one-shot mutation from firing twice under React
  // strict mode / re-renders.
  const { mutate } = confirm;
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    mutate({ code });
  }, [mutate, code]);

  if (confirm.isError) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <h1 className="text-lg font-light">Couldn&apos;t connect the CLI</h1>
        <p className="text-sm text-red-500">{confirm.error.message}</p>
        <p className="text-muted-foreground text-xs">
          Run <code>vg login</code> to try again.
        </p>
      </div>
    );
  }

  if (confirm.isSuccess) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <h1 className="text-lg font-light">Successfully connected</h1>
        <p className="text-muted-foreground text-sm">
          The VG CLI is now authorized as <strong>{userName}</strong>. You can close this window.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-center">
      <h1 className="text-lg font-light">Connecting the VG CLI…</h1>
      <p className="text-muted-foreground text-sm">
        Authorizing as <strong>{userName}</strong>.
      </p>
    </div>
  );
};
