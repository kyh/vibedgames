import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { toast } from "@repo/ui/components/sonner";

import { authClient } from "@/auth/client";
import { ScopeList } from "@/components/oauth/scope-list";

type DeviceRequest =
  | { state: "enter" | "expired" | "unknown" | "used"; userName: string }
  | {
      clientName: string | null;
      scopes: string[];
      state: "pending";
      userCode: string;
      userName: string;
    };

const NOTICES = {
  expired: "That code has expired. Run `vg login` again for a new one.",
  unknown: "No device is waiting for that code. Check it against your terminal.",
  used: "That code has already been answered.",
} as const;

/** Asks for the code the CLI printed, when the page was opened without one. */
const EnterCode = ({ notice }: { notice?: string }) => {
  const router = useRouter();
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void router.navigate({ search: { user_code: code.trim() }, to: "/device" });
      }}
    >
      <div className="grid gap-1 text-center">
        <h1 className="text-lg font-light">Connect a device</h1>
        <p className="text-muted-foreground text-sm">Enter the code your terminal shows.</p>
      </div>
      {notice && <p className="text-sm text-red-400">{notice}</p>}
      <Input
        aria-label="Device code"
        autoCapitalize="characters"
        autoComplete="off"
        className="text-center font-mono tracking-[0.3em]"
        placeholder="ABCD2345"
        value={code}
        variant="frosted"
        onChange={(event) => setCode(event.target.value)}
      />
      <Button type="submit" disabled={!code.trim()}>
        Continue
      </Button>
    </form>
  );
};

/**
 * Approve or deny a device code the signed-in person claimed by opening it.
 * The code is shown large so it can be matched against the terminal: anyone
 * can start `vg login` and send a link, so only the person who did should
 * approve (RFC 8628 §5.4).
 */
export const DeviceApproval = ({ request }: { request: DeviceRequest }) => {
  const [answer, setAnswer] = useState<"approved" | "denied" | null>(null);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  if (request.state !== "pending") {
    return <EnterCode notice={request.state === "enter" ? undefined : NOTICES[request.state]} />;
  }

  if (answer) {
    return (
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-lg font-light">
          {answer === "approved" ? "Device connected" : "Request denied"}
        </h1>
        <p className="text-muted-foreground text-sm">
          {answer === "approved"
            ? "Return to your terminal; you can close this window."
            : "Nothing was connected. You can close this window."}
        </p>
      </div>
    );
  }

  const respond = async (approve: boolean) => {
    setPending(approve ? "approve" : "deny");
    const result = approve
      ? await authClient.device.approve({ userCode: request.userCode })
      : await authClient.device.deny({ userCode: request.userCode });
    setPending(null);
    if (result.error) {
      toast.error(result.error.error_description ?? "Something went wrong. Please try again.");
      return;
    }
    setAnswer(approve ? "approved" : "denied");
  };

  const name = request.clientName ?? "A device";
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-1 text-center">
        <h1 className="text-lg font-light">Connect {name}</h1>
        <p className="text-muted-foreground text-sm">
          Signed in as <strong>{request.userName}</strong>
        </p>
      </div>
      <code className="rounded-md bg-white/10 px-4 py-3 text-center font-mono text-2xl tracking-[0.3em]">
        {request.userCode}
      </code>
      <div className="grid gap-3 text-sm">
        <p>{name} will be able to:</p>
        <ScopeList scopes={request.scopes} />
        <p className="text-muted-foreground text-xs">
          Approve only if you started this from your own terminal and it shows this code.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          loading={pending === "deny"}
          disabled={pending !== null}
          onClick={() => {
            void respond(false);
          }}
        >
          Deny
        </Button>
        <Button
          type="button"
          loading={pending === "approve"}
          disabled={pending !== null}
          onClick={() => {
            void respond(true);
          }}
        >
          Approve
        </Button>
      </div>
    </div>
  );
};
