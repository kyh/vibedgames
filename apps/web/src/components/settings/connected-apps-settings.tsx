import { OAUTH_SCOPES } from "@repo/contract/auth/oauth-scopes";
import { Button } from "@repo/ui/components/button";
import { Skeleton } from "@repo/ui/components/skeleton";
import { toast } from "@repo/ui/components/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { formatDate } from "@/lib/format";
import { useORPC } from "@/lib/orpc";

/** The vibedgames scopes an app holds, with the consent page's wording; OpenID's are left out. */
const grantedScopes = (scopes: readonly string[]) =>
  Object.entries(OAUTH_SCOPES).filter(([scope]) => scopes.includes(scope));

const AppsSkeleton = () => (
  <ul className="divide-y divide-white/10 border-t border-white/10">
    <li className="flex items-center gap-3 py-4">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-56" />
      </div>
      <Skeleton className="ml-auto h-4 w-20" />
    </li>
  </ul>
);

/**
 * The apps the person approved over OAuth (claude.ai, ChatGPT, Claude Code,
 * …) and a way to disconnect each: its consent and refresh tokens go, so it
 * must ask again.
 */
export const ConnectedAppsSettings = () => {
  const orpc = useORPC();
  const qc = useQueryClient();
  const list = useQuery(orpc.connectedApps.list.queryOptions());
  const revoke = useMutation(
    orpc.connectedApps.revoke.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: orpc.connectedApps.list.queryKey() });
        toast.success("App disconnected");
      },
    }),
  );

  return (
    <section
      id="connected-apps"
      className="grid scroll-mt-28 grid-cols-1 gap-x-8 gap-y-6 py-12 first:pt-0 last:pb-0 md:grid-cols-3"
    >
      <header>
        <h2 className="text-base font-semibold">Connected apps</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Apps you let act for you, such as an AI assistant connected to vibedgames. Disconnecting
          one stops it within the hour.
        </p>
      </header>

      <div className="md:col-span-2">
        <SkeletonReveal ready={list.data !== undefined || list.isError} skeleton={<AppsSkeleton />}>
          {list.isError && (
            <p className="text-muted-foreground text-sm">
              Couldn&apos;t load connected apps. Try reloading.
            </p>
          )}
          {list.data?.apps.length === 0 && (
            <p className="text-muted-foreground text-sm">No apps connected.</p>
          )}
          {list.data && list.data.apps.length > 0 && (
            <ul className="divide-y divide-white/10 border-t border-white/10">
              {list.data.apps.map((app) => {
                const granted = grantedScopes(app.scopes);
                return (
                  <li key={app.clientId} className="flex items-center gap-3 py-4 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{app.name ?? "Unnamed app"}</div>
                      <div className="text-muted-foreground text-xs">
                        {app.connectedAt ? `connected ${formatDate(app.connectedAt)}` : "connected"}
                        {app.uri ? (
                          <>
                            {" · "}
                            <span className="select-text">{app.uri}</span>
                          </>
                        ) : null}
                      </div>
                      {granted.length > 0 && (
                        <ul className="mt-2 flex flex-wrap gap-1">
                          {granted.map(([scope, label]) => (
                            <li
                              key={scope}
                              title={label}
                              className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs"
                            >
                              {scope}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      loading={revoke.isPending && revoke.variables?.clientId === app.clientId}
                      onClick={() => revoke.mutate({ clientId: app.clientId })}
                    >
                      Disconnect
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </SkeletonReveal>
      </div>
    </section>
  );
};
