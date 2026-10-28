import { Button } from "@repo/ui/components/button";
import { useMutation } from "@tanstack/react-query";

import { useORPC } from "@/lib/orpc";

interface CliAuthConfirmProps {
  code: string;
  userName: string;
}

/**
 * Confirming hands this browser's session to whoever started `vg login` with
 * this code, so it takes a click, never just a visit: anyone can run
 * `vg login` and send a signed-in person the link. The code is shown large so
 * the person can match it against their own terminal (RFC 8628 §5.4).
 */
export const CliAuthConfirm = ({ code, userName }: CliAuthConfirmProps) => {
  const orpc = useORPC();
  // Deliberately invalidates nothing: `cliConfirm` writes the device-code
  // row that `auth.cliPoll` reads, and cliPoll is only ever called by the
  // CLI over HTTP — no query in this app observes it.
  const confirm = useMutation(orpc.auth.cliConfirm.mutationOptions());

  if (confirm.isError) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <h1 className="text-lg font-light">Couldn&apos;t connect the CLI</h1>
        <p className="text-sm text-red-500 select-text">{confirm.error.message}</p>
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
    <div className="flex flex-col gap-6 text-center">
      <div className="grid gap-1">
        <h1 className="text-lg font-light">Connect the VG CLI</h1>
        <p className="text-muted-foreground text-sm">
          Signed in as <strong>{userName}</strong>
        </p>
      </div>
      <code className="rounded-md bg-white/10 px-4 py-3 font-mono text-2xl tracking-[0.3em]">
        {code}
      </code>
      <p className="text-muted-foreground text-sm">
        Approve only if you just ran <code>vg login</code> and your terminal shows this code. The
        CLI will act as you.
      </p>
      <Button
        type="button"
        loading={confirm.isPending}
        disabled={confirm.isPending}
        onClick={() => confirm.mutate({ code })}
      >
        Approve
      </Button>
    </div>
  );
};
