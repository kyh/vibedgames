import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Skeleton } from "@repo/ui/components/skeleton";
import { toast } from "@repo/ui/components/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon } from "lucide-react";

import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { useTRPC } from "@/lib/trpc";

const buildInviteLink = (code: string) => {
  if (typeof window === "undefined") return `/auth/register?invite=${code}`;
  return `${window.location.origin}/auth/register?invite=${code}`;
};

const CodesSkeleton = () => (
  <ul className="divide-y divide-white/10 border-t border-white/10">
    {Array.from({ length: 3 }, (_, i) => (
      <li key={i} className="flex h-12 items-center gap-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-3 w-14" />
        <Skeleton className="ml-auto h-4 w-24" />
      </li>
    ))}
  </ul>
);

const codeStatus = (row: {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
}) => {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return "expired";
  if (row.maxUses != null && row.usedCount >= row.maxUses) return "used";
  return "available";
};

export const InviteAdmin = () => {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const list = useQuery(trpc.auth.listInvites.queryOptions());
  const create = useMutation(
    trpc.auth.createInvites.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.auth.listInvites.queryKey() });
        toast.success("Invite codes created");
      },
      onError: (err) => toast.error(err.message),
    }),
  );
  const revoke = useMutation(
    trpc.auth.revokeInvite.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.auth.listInvites.queryKey() });
        toast.success("Code revoked");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const [count, setCount] = useState(1);
  const [maxUses, setMaxUses] = useState<number | "">(1);
  const [note, setNote] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const trimmedCustomCode = customCode.trim();

  const copyLink = (code: string) => {
    navigator.clipboard
      .writeText(buildInviteLink(code))
      .then(() => {
        setCopied(code);
        setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500);
      })
      .catch(() => toast.error("Copy failed"));
  };

  return (
    <section
      id="invites"
      className="grid scroll-mt-28 grid-cols-1 gap-x-8 gap-y-6 py-12 first:pt-0 last:pb-0 md:grid-cols-3"
    >
      <header>
        <h2 className="text-base font-semibold">Invite codes</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Generate codes for early-preview signups. Single-use by default.
        </p>
      </header>

      <div className="space-y-6 md:col-span-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              count,
              maxUses: maxUses === "" ? null : maxUses,
              expiresAt: null,
              note: note.trim() || null,
              code: trimmedCustomCode === "" ? null : trimmedCustomCode,
            });
          }}
          className="bg-input/40 space-y-4 rounded-md p-4 backdrop-blur-sm"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field className="gap-1">
              <FieldLabel htmlFor="count">Count</FieldLabel>
              <FieldContent>
                <Input
                  id="count"
                  type="number"
                  min={1}
                  max={100}
                  disabled={trimmedCustomCode !== ""}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value) || 1)}
                />
              </FieldContent>
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="maxUses">Max uses (blank = unlimited)</FieldLabel>
              <FieldContent>
                <Input
                  id="maxUses"
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) =>
                    setMaxUses(e.target.value === "" ? "" : Number(e.target.value) || 1)
                  }
                />
              </FieldContent>
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="custom-code">Custom code (optional)</FieldLabel>
              <FieldContent>
                <Input
                  id="custom-code"
                  type="text"
                  maxLength={6}
                  placeholder="e.g. LAUNCH — 6 chars, replaces count"
                  className="font-mono uppercase"
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
                />
              </FieldContent>
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="note">Note</FieldLabel>
              <FieldContent>
                <Input
                  id="note"
                  type="text"
                  placeholder="e.g. twitter giveaway"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </FieldContent>
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={create.isPending}>
              Generate
            </Button>
          </div>
        </form>

        <SkeletonReveal
          ready={list.data !== undefined || list.isError}
          skeleton={<CodesSkeleton />}
        >
          {list.isError && (
            <p className="text-muted-foreground text-sm">Couldn't load codes. Try reloading.</p>
          )}
          {list.data?.codes.length === 0 && (
            <p className="text-muted-foreground text-sm">No codes yet.</p>
          )}
          {list.data && list.data.codes.length > 0 && (
            <ul className="divide-y divide-white/10 border-t border-white/10">
              {list.data.codes.map((row) => {
                const status = codeStatus(row);
                return (
                  <li key={row.id} className="flex items-center gap-3 py-3 text-sm">
                    <code className="font-mono text-base">{row.code}</code>
                    <span
                      className={
                        status === "available"
                          ? "rounded bg-green-900/40 px-2 py-0.5 text-xs text-green-200"
                          : status === "used"
                            ? "rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
                            : "rounded bg-red-900/40 px-2 py-0.5 text-xs text-red-200"
                      }
                    >
                      {status}
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      {row.usedCount}/{row.maxUses ?? "∞"} uses
                    </span>
                    {row.note && (
                      <span className="text-muted-foreground min-w-0 truncate italic">
                        {row.note}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => copyLink(row.code)}
                      >
                        {copied === row.code ? (
                          <CheckIcon className="size-3.5" />
                        ) : (
                          <CopyIcon className="size-3.5" />
                        )}
                        Link
                      </Button>
                      {status === "available" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          loading={revoke.isPending && revoke.variables?.id === row.id}
                          onClick={() => revoke.mutate({ id: row.id })}
                        >
                          Revoke
                        </Button>
                      )}
                    </span>
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
