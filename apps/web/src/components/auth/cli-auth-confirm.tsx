import { Button } from "@repo/ui/components/button";
import { useMutation } from "@tanstack/react-query";

import { useTRPC } from "@/lib/trpc";

type CliAuthConfirmProps = {
  code: string;
  userName: string;
};

export const CliAuthConfirm = ({ code, userName }: CliAuthConfirmProps) => {
  const trpc = useTRPC();
  const confirm = useMutation(trpc.auth.cliConfirm.mutationOptions());

  return (
    <div className="flex flex-col gap-4 text-center">
      <h1 className="text-lg font-light">Authorize VG CLI</h1>
      <p className="text-muted-foreground text-sm">
        The VG CLI is requesting access as <strong>{userName}</strong>.
      </p>
      <p className="font-mono text-2xl tracking-widest">{code}</p>
      <p className="text-muted-foreground text-xs">
        Confirm this code matches what you see in your terminal.
      </p>
      {confirm.isSuccess ? (
        <p className="text-sm text-green-500">
          Authorized! You can close this window.
        </p>
      ) : (
        <Button
          onClick={() => confirm.mutate({ code })}
          loading={confirm.isPending}
        >
          Authorize
        </Button>
      )}
      {confirm.isError && (
        <p className="text-sm text-red-500">
          {confirm.error.message}
        </p>
      )}
    </div>
  );
};
