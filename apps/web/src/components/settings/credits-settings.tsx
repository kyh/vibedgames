import { useQuery } from "@tanstack/react-query";

import { formatUsd, kindLabel } from "@/lib/credits-format";
import { useTRPC } from "@/lib/trpc";

export const CreditsSettings = () => {
  const trpc = useTRPC();
  const credits = useQuery(trpc.credits.me.queryOptions());

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-2xl font-light">Credits</h2>
        <p className="text-muted-foreground text-sm">
          Credits cover asset generation. New accounts start with $20.
        </p>
      </header>

      {credits.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
      {credits.isError && (
        <p className="text-muted-foreground text-sm">Couldn't load credits. Try reloading.</p>
      )}

      {credits.data && (
        <>
          <div className="rounded-md border border-white/10 p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Balance
            </div>
            <div className="mt-1 text-3xl font-light tabular-nums">
              {formatUsd(credits.data.balanceMicro)}
            </div>
          </div>

          <section>
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              History
            </h3>
            {credits.data.entries.length === 0 && (
              <p className="text-muted-foreground text-sm">No activity yet.</p>
            )}
            {credits.data.entries.length > 0 && (
              <ul className="divide-y divide-white/10 rounded-md border border-white/10">
                {credits.data.entries.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 p-3 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{kindLabel(e.kind, e.deltaMicro)}</div>
                      <div className="text-muted-foreground text-xs">
                        {e.endpointId != null && (
                          <>
                            <code className="font-mono">{e.endpointId}</code> ·{" "}
                          </>
                        )}
                        {new Date(e.createdAt).toLocaleDateString()}
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
          </section>
        </>
      )}
    </div>
  );
};
