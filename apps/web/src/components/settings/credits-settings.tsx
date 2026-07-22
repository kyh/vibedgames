import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@repo/ui/components/skeleton";

import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { formatUsd, kindLabel } from "@/lib/credits-format";
import { formatDate } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

const CreditsSkeleton = () => (
  <div className="space-y-8">
    <div>
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Balance
      </div>
      <Skeleton className="mt-2 h-8 w-28" />
    </div>
    <div>
      <ul className="divide-y divide-white/10 border-t border-white/10">
        {Array.from({ length: 3 }, (_, i) => (
          <li key={i} className="flex items-center gap-3 py-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="ml-auto h-3 w-12" />
          </li>
        ))}
      </ul>
    </div>
  </div>
);

export const CreditsSettings = () => {
  const trpc = useTRPC();
  const credits = useQuery(trpc.credits.me.queryOptions());

  return (
    <section
      id="credits"
      className="grid scroll-mt-28 grid-cols-1 gap-x-8 gap-y-6 py-12 first:pt-0 last:pb-0 md:grid-cols-3"
    >
      <header>
        <h2 className="text-base font-semibold">Credits</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Credits cover asset generation. New accounts start with $20.
        </p>
      </header>

      <div className="md:col-span-2">
        {credits.isError && (
          <p className="text-muted-foreground text-sm">Couldn't load credits. Try reloading.</p>
        )}

        {!credits.isError && (
          <SkeletonReveal ready={credits.data !== undefined} skeleton={<CreditsSkeleton />}>
            {credits.data && (
              <div className="space-y-8">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Balance
                  </div>
                  <div className="mt-1 text-3xl font-light tabular-nums">
                    {formatUsd(credits.data.balanceMicro)}
                  </div>
                </div>

                <div>
                  {credits.data.entries.length === 0 && (
                    <p className="text-muted-foreground text-sm">No activity yet.</p>
                  )}
                  {credits.data.entries.length > 0 && (
                    <ul className="divide-y divide-white/10 border-t border-white/10">
                      {credits.data.entries.map((e) => (
                        <li key={e.id} className="flex items-center gap-3 py-4 text-sm">
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {kindLabel(e.kind, e.deltaMicro)}
                            </div>
                            <div className="text-muted-foreground text-xs">
                              {e.endpointId != null && (
                                <>
                                  <code className="font-mono">{e.endpointId}</code> ·{" "}
                                </>
                              )}
                              {formatDate(e.createdAt)}
                            </div>
                          </div>
                          <span
                            className={`ml-auto font-mono text-xs tabular-nums ${
                              e.deltaMicro < 0 ? "text-red-300/90" : "text-green-300/90"
                            }`}
                          >
                            {e.deltaMicro > 0 ? "+" : ""}
                            {formatUsd(e.deltaMicro)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </SkeletonReveal>
        )}
      </div>
    </section>
  );
};
