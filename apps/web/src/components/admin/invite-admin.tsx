import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { toast } from "@repo/ui/components/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useTRPC } from "@/lib/trpc";

const buildInviteLink = (code: string) => {
  if (typeof window === "undefined") return `/auth/register?invite=${code}`;
  return `${window.location.origin}/auth/register?invite=${code}`;
};

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

  const list = useQuery(trpc.invite.list.queryOptions());
  const create = useMutation(
    trpc.invite.create.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.invite.list.queryKey() });
        toast.success("Invite codes created");
      },
      onError: (err) => toast.error(err.message),
    }),
  );
  const revoke = useMutation(
    trpc.invite.revoke.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.invite.list.queryKey() });
        toast.success("Code revoked");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const [count, setCount] = useState(1);
  const [maxUses, setMaxUses] = useState<number | "">(1);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

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
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-light">Invite codes</h1>
        <p className="text-muted-foreground text-sm">
          Generate codes for early-preview signups. Single-use by default.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({
            count,
            maxUses: maxUses === "" ? null : maxUses,
            expiresAt: null,
            note: note.trim() || null,
          });
        }}
        className="grid grid-cols-1 gap-3 rounded-md border border-white/10 p-4 sm:grid-cols-4"
      >
        <Field className="gap-1">
          <FieldLabel htmlFor="count">Count</FieldLabel>
          <FieldContent>
            <Input
              id="count"
              type="number"
              min={1}
              max={100}
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
        <Field className="gap-1 sm:col-span-2">
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
        <div className="sm:col-span-4">
          <Button loading={create.isPending}>Generate</Button>
        </div>
      </form>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Existing codes
        </h2>
        {list.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
        {list.data?.codes.length === 0 && (
          <p className="text-muted-foreground text-sm">No codes yet.</p>
        )}
        <ul className="divide-y divide-white/10 rounded-md border border-white/10">
          {list.data?.codes.map((row) => {
            const status = codeStatus(row);
            return (
              <li key={row.id} className="flex items-center gap-3 p-3 text-sm">
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
                <span className="text-muted-foreground">
                  {row.usedCount}/{row.maxUses ?? "∞"} uses
                </span>
                {row.note && <span className="text-muted-foreground italic">{row.note}</span>}
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
      </section>
    </div>
  );
};
