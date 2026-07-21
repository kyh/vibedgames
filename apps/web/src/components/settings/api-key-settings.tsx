import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { InputGroup, InputGroupInput } from "@repo/ui/components/input-group";
import { Skeleton } from "@repo/ui/components/skeleton";
import { toast } from "@repo/ui/components/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon } from "lucide-react";

import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { useTRPC } from "@/lib/trpc";

const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleDateString() : "never");

const KeysSkeleton = () => (
  <ul className="divide-y divide-white/10 border-t border-white/10">
    {Array.from({ length: 2 }, (_, i) => (
      <li key={i} className="flex items-center gap-3 py-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="ml-auto h-4 w-14" />
      </li>
    ))}
  </ul>
);

export const ApiKeySettings = () => {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const list = useQuery(trpc.apiKeys.list.queryOptions());
  const create = useMutation(
    trpc.apiKeys.create.mutationOptions({
      onSuccess: (data) => {
        qc.invalidateQueries({ queryKey: trpc.apiKeys.list.queryKey() });
        setNewKey(data.key);
        setName("");
        setExpiresInDays("");
        toast.success("API key created");
      },
      onError: (err) => toast.error(err.message),
    }),
  );
  const revoke = useMutation(
    trpc.apiKeys.revoke.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.apiKeys.list.queryKey() });
        toast.success("Key revoked");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<number | "">("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyKey = () => {
    if (!newKey) return;
    navigator.clipboard
      .writeText(newKey)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error("Copy failed"));
  };

  return (
    <section
      id="api-keys"
      className="grid scroll-mt-28 grid-cols-1 gap-x-8 gap-y-6 py-12 first:pt-0 last:pb-0 md:grid-cols-3"
    >
      <header>
        <h2 className="text-base font-semibold">API keys</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Long-lived keys for using the <code>vg</code> CLI in CI. Set a key as the{" "}
          <code>VG_TOKEN</code> environment variable.
        </p>
      </header>

      <div className="space-y-6 md:col-span-2">
        {newKey && (
          <div className="space-y-2 rounded-md border border-green-500/30 bg-green-900/20 p-4">
            <p className="text-sm font-medium text-green-200">
              Copy your key now — it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-black/40 px-3 py-2 font-mono text-sm">
                {newKey}
              </code>
              <Button type="button" variant="ghost" size="sm" onClick={copyKey}>
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                Copy
              </Button>
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate({
              name: name.trim(),
              expiresInDays: expiresInDays === "" ? null : expiresInDays,
            });
          }}
          className="bg-input/40 space-y-2 rounded-md p-4 backdrop-blur-sm"
        >
          <InputGroup>
            <InputGroupInput
              type="text"
              aria-label="Key name"
              placeholder="Key name — e.g. github-actions"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
            <InputGroupInput
              type="number"
              aria-label="Expires in days (blank = never)"
              placeholder="Expires (days)"
              className="w-32 flex-none border-l border-white/10"
              min={1}
              max={3650}
              value={expiresInDays}
              onChange={(e) =>
                setExpiresInDays(e.target.value === "" ? "" : Number(e.target.value) || 1)
              }
            />
          </InputGroup>
          <p className="text-muted-foreground text-xs">
            Leave days blank for a key that never expires.
          </p>
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={create.isPending} disabled={!name.trim()}>
              Create key
            </Button>
          </div>
        </form>

        <div>
          <SkeletonReveal
            ready={list.data !== undefined || list.isError}
            skeleton={<KeysSkeleton />}
          >
            {list.isError && (
              <p className="text-muted-foreground text-sm">Couldn't load keys. Try reloading.</p>
            )}
            {list.data?.keys.length === 0 && (
              <p className="text-muted-foreground text-sm">No keys yet.</p>
            )}
            {list.data && list.data.keys.length > 0 && (
              <ul className="divide-y divide-white/10 border-t border-white/10">
                {list.data.keys.map((k) => {
                  const expired =
                    k.expiresAt != null && new Date(k.expiresAt).getTime() < Date.now();
                  return (
                    <li key={k.id} className="flex items-center gap-3 py-4 text-sm">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <code className="font-mono">{k.keyPrefix}…</code>
                          <span className="truncate font-medium">{k.name}</span>
                          {expired && (
                            <span className="rounded bg-red-900/40 px-2 py-0.5 text-xs text-red-200">
                              expired
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground text-xs">
                          created {fmt(k.createdAt)} · last used {fmt(k.lastUsedAt)} · expires{" "}
                          {fmt(k.expiresAt)}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        loading={revoke.isPending && revoke.variables?.id === k.id}
                        onClick={() => revoke.mutate({ id: k.id })}
                      >
                        Revoke
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SkeletonReveal>
        </div>
      </div>
    </section>
  );
};
