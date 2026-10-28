import { useState } from "react";
import { OAUTH_SCOPES } from "@repo/contract/auth/oauth-scopes";
import { Button } from "@repo/ui/components/button";
import { toast } from "@repo/ui/components/sonner";

import { authClient } from "@/auth/client";

/**
 * What each scope lets the app do, in the person's terms: OpenID's, then
 * vibedgames' own (`@repo/contract/auth/oauth-scopes`).
 */
const SCOPE_LABELS = new Map<string, string>([
  ["openid", "Know who you are"],
  ["profile", "See your name and picture"],
  ["email", "See your email address"],
  ...Object.entries(OAUTH_SCOPES),
  ["offline_access", "Stay connected while you are away"],
]);

interface OAuthConsentProps {
  clientName: string | null;
  clientUri: string | null;
  redirectHost: string | null;
  scopes: string[];
  userName: string;
}

/**
 * Allow or deny. Either answer goes back to the OAuth provider with the signed
 * query attached (the client plugin does that), and the provider answers with
 * the app's redirect, which the auth client follows.
 */
export const OAuthConsent = ({
  clientName,
  clientUri,
  redirectHost,
  scopes,
  userName,
}: OAuthConsentProps) => {
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const name = clientName ?? "An app";

  const answer = async (accept: boolean) => {
    setPending(accept ? "allow" : "deny");
    await authClient.oauth2.consent({
      accept,
      fetchOptions: {
        onError: (ctx) => {
          toast.error(ctx.error.message);
          setPending(null);
        },
      },
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-1 text-center">
        <h1 className="text-lg font-light">Connect {name} to vibedgames</h1>
        <p className="text-muted-foreground text-sm">
          Signed in as <strong>{userName}</strong>
        </p>
      </div>
      <div className="grid gap-3 text-sm">
        <p>{name} will be able to:</p>
        <ul className="text-muted-foreground list-disc space-y-1 pl-5">
          {[...SCOPE_LABELS].flatMap(([scope, label]) =>
            scopes.includes(scope) ? [<li key={scope}>{label}</li>] : [],
          )}
        </ul>
        {(redirectHost ?? clientUri) && (
          <p className="text-muted-foreground text-xs">
            You will be sent back to{" "}
            <span className="text-foreground select-text">{redirectHost}</span>
            {clientUri ? (
              <>
                {" "}
                (<span className="select-text">{clientUri}</span>)
              </>
            ) : null}
            . Only allow apps you trust; anyone can register one.
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          loading={pending === "deny"}
          disabled={pending !== null}
          onClick={() => answer(false)}
        >
          Deny
        </Button>
        <Button
          type="button"
          loading={pending === "allow"}
          disabled={pending !== null}
          onClick={() => answer(true)}
        >
          Allow
        </Button>
      </div>
    </div>
  );
};
