import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@repo/ui/components/button";

import { authClient } from "@/auth/client";

/** What each requested scope lets the connecting app do, in the user's terms. */
const SCOPE_COPY = {
  email: "See your email address",
  offline_access: "Stay connected until you disconnect it",
  openid: "Confirm who you are",
  profile: "See your name",
};

type KnownScope = keyof typeof SCOPE_COPY;

const isKnownScope = (scope: string): scope is KnownScope => Object.hasOwn(SCOPE_COPY, scope);

interface OAuthConsentProps {
  clientId: string;
  scope: string;
}

/**
 * The approval step an MCP connector's sign-in stops at. Approving grants the
 * connector the same reach as a vibedgames API key: generate assets on your
 * credits and manage your deployed games.
 */
export const OAuthConsent = ({ clientId, scope }: OAuthConsentProps) => {
  const client = useQuery({
    queryFn: async () => {
      const { data, error } = await authClient.oauth2.publicClient({
        query: { client_id: clientId },
      });
      if (error) {
        throw new Error(error.message ?? "Unknown app");
      }
      return data;
    },
    queryKey: ["oauth-public-client", clientId],
  });

  // The client's redirect plugin follows the `{ redirect, url }` answer back to
  // the connector, so success needs no handling here.
  const decide = useMutation({
    mutationFn: async (accept: boolean) => {
      const { error } = await authClient.oauth2.consent({ accept });
      if (error) {
        throw new Error(error.message ?? "Could not complete sign-in");
      }
    },
  });

  const appName = client.data?.client_name ?? "An app";
  const scopes = scope.split(" ").filter(isKnownScope);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-lg font-light">{appName} wants to connect</h1>
        <p className="text-muted-foreground text-sm">
          It will be able to generate assets on your credits and manage your deployed games.
        </p>
      </div>
      {scopes.length > 0 && (
        <ul className="text-muted-foreground grid gap-1 text-sm">
          {scopes.map((s) => (
            <li key={s}>{SCOPE_COPY[s]}</li>
          ))}
        </ul>
      )}
      {decide.isError && <p className="text-sm text-red-500">{decide.error.message}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
          Deny
        </Button>
        <Button disabled={decide.isPending || client.isPending} onClick={() => decide.mutate(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
};
