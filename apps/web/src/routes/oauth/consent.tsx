import { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getServerContext } from "@/auth/server";
import { leaveFor } from "@/lib/leave-for";
import { OAuthConsent } from "@/components/oauth/oauth-consent";

const consentSearchSchema = z.looseObject({
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  scope: z.string().optional(),
});

const fetchConsent = createServerFn({ method: "GET" })
  .validator(z.object({ search: z.string() }))
  .handler(async ({ data: { search } }) => {
    const clientId = new URLSearchParams(search).get("client_id");
    const { auth } = getServerContext();
    const headers = new Headers(getRequestHeaders());
    const session = await auth.api.getSession({ headers });

    if (!session) {
      leaveFor(`/auth/login${search}`);
    }

    if (clientId === null || clientId === "") {
      return { client: null, userName: session.user.name };
    }

    const client = await auth.api
      .getOAuthClientPublic({ headers, query: { client_id: clientId } })
      .catch(() => null);

    return {
      client: client ? { name: client.client_name ?? null, uri: client.client_uri ?? null } : null,
      userName: session.user.name,
    };
  });

const redirectHost = (uri?: string) => {
  if (uri === undefined || uri === "") {
    return null;
  }

  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
};

const ConsentPage = () => {
  const { client, userName } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      <div className="mx-auto flex w-full flex-col sm:w-[380px]">
        {client ? (
          <OAuthConsent
            clientName={client.name}
            clientUri={client.uri}
            redirectHost={redirectHost(search.redirect_uri)}
            scopes={search.scope?.split(" ").filter(Boolean) ?? []}
            userName={userName}
          />
        ) : (
          <div className="text-center">
            <h1 className="text-lg font-light">Invalid request</h1>
            <p className="text-muted-foreground text-sm">
              This app is not registered. Start connecting it again from the app.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export const Route = createFileRoute("/oauth/consent")({
  component: ConsentPage,
  head: () => ({
    meta: [{ title: "Connect an app" }, { content: "noindex, nofollow", name: "robots" }],
  }),
  loader: async ({ location }) => await fetchConsent({ data: { search: location.searchStr } }),
  validateSearch: consentSearchSchema,
});
