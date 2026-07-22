import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Field, FieldContent, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Skeleton } from "@repo/ui/components/skeleton";
import { toast } from "@repo/ui/components/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { formatUsd } from "@/lib/credits-format";
import { formatDate } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

type Role = "user" | "admin";

type UserForm = {
  email: string;
  password: string;
  name: string;
  role: Role;
};

const initialForm: UserForm = {
  email: "",
  password: "",
  name: "",
  role: "user",
};

const parseRole = (value: string): Role => (value === "admin" ? "admin" : "user");

const UsersSkeleton = () => (
  <ul className="divide-y divide-white/10 border-t border-white/10">
    {Array.from({ length: 3 }, (_, i) => (
      <li key={i} className="flex h-12 items-center gap-3">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="ml-auto h-4 w-12" />
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-4 w-20" />
      </li>
    ))}
  </ul>
);

export const UserAdmin = () => {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const list = useQuery(trpc.admin.users.list.queryOptions());
  const balances = useQuery(trpc.admin.credits.balances.queryOptions());
  const create = useMutation(
    trpc.admin.users.create.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.admin.users.list.queryKey() });
        setForm(initialForm);
        toast.success("User created");
      },
      onError: (err) => toast.error(err.message),
    }),
  );
  const grant = useMutation(
    trpc.admin.credits.grant.mutationOptions({
      onSuccess: ({ balanceMicro }) => {
        qc.invalidateQueries({ queryKey: trpc.admin.credits.balances.queryKey() });
        setGrantTarget(null);
        toast.success(`Credits updated — new balance ${formatUsd(balanceMicro)}`);
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const [form, setForm] = useState(initialForm);
  const [grantTarget, setGrantTarget] = useState<{ id: string; email: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  // Idempotency key for the pending grant: minted per dialog-open, so a
  // retried submit of the same dialog can't grant twice, while reopening
  // starts a fresh grant.
  const [grantKey, setGrantKey] = useState("");

  const balanceByUser = new Map(
    balances.data?.balances.map((b): [string, number] => [b.userId, b.balanceMicro]) ?? [],
  );
  const balanceLabel = (userId: string) => {
    if (!balances.data) return "—";
    // Users without ledger rows get the signup grant on first use.
    return formatUsd(balanceByUser.get(userId) ?? balances.data.signupGrantMicro);
  };

  const openGrant = (target: { id: string; email: string }) => {
    setAmount("");
    setNote("");
    setGrantKey(crypto.randomUUID());
    setGrantTarget(target);
  };

  return (
    <section
      id="users"
      className="grid scroll-mt-28 grid-cols-1 gap-x-8 gap-y-6 py-12 first:pt-0 last:pb-0 md:grid-cols-3"
    >
      <header>
        <h2 className="text-base font-semibold">Users</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Create accounts directly — no invite code needed.
        </p>
      </header>

      <div className="space-y-6 md:col-span-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(form);
          }}
          className="bg-input/40 space-y-4 rounded-md p-4 backdrop-blur-sm"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field className="gap-1">
              <FieldLabel htmlFor="user-name">Name</FieldLabel>
              <FieldContent>
                <Input
                  id="user-name"
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </FieldContent>
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="user-email">Email</FieldLabel>
              <FieldContent>
                <Input
                  id="user-email"
                  type="email"
                  required
                  autoComplete="off"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
              </FieldContent>
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="user-password">Password</FieldLabel>
              <FieldContent>
                <Input
                  id="user-password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                />
              </FieldContent>
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="user-role">Role</FieldLabel>
              <FieldContent>
                <select
                  id="user-role"
                  className="bg-input text-foreground h-9 rounded-md border border-white/10 px-2 text-sm"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: parseRole(e.target.value) }))}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </FieldContent>
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={create.isPending}>
              Create user
            </Button>
          </div>
        </form>

        <SkeletonReveal
          ready={list.data !== undefined || list.isError}
          skeleton={<UsersSkeleton />}
        >
          {list.isError && (
            <p className="text-muted-foreground text-sm">Couldn't load users. Try reloading.</p>
          )}
          {list.data?.users.length === 0 && (
            <p className="text-muted-foreground text-sm">No users yet.</p>
          )}
          {list.data && list.data.users.length > 0 && (
            <ul className="divide-y divide-white/10 border-t border-white/10">
              {list.data.users.map((u) => (
                <li key={u.id} className="flex items-center gap-3 py-3 text-sm">
                  <span className="min-w-0 truncate font-mono">{u.email}</span>
                  <span className="text-muted-foreground min-w-16 flex-1 truncate">{u.name}</span>
                  {u.role === "admin" && (
                    <span className="shrink-0 rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-200">
                      admin
                    </span>
                  )}
                  {u.banned && (
                    <span className="shrink-0 rounded bg-red-900/40 px-2 py-0.5 text-xs text-red-200">
                      banned
                    </span>
                  )}
                  <span className="ml-auto shrink-0 tabular-nums">{balanceLabel(u.id)}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatDate(u.createdAt)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => openGrant({ id: u.id, email: u.email })}
                  >
                    Grant credits
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SkeletonReveal>
      </div>

      <Dialog
        open={grantTarget !== null}
        onOpenChange={(open) => {
          if (!open) setGrantTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grant credits</DialogTitle>
            <DialogDescription>
              Adjust generation credits for <span className="font-mono">{grantTarget?.email}</span>.
              Use a negative amount to claw back.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!grantTarget) return;
              const amountUsd = Number(amount);
              if (
                !Number.isFinite(amountUsd) ||
                amountUsd === 0 ||
                amountUsd < -1000 ||
                amountUsd > 1000
              ) {
                toast.error("Amount must be non-zero, between -$1,000 and $1,000");
                return;
              }
              const trimmedNote = note.trim();
              grant.mutate({
                userId: grantTarget.id,
                amountUsd,
                note: trimmedNote === "" ? undefined : trimmedNote,
                key: grantKey,
              });
            }}
            className="space-y-3"
          >
            <Field className="gap-1">
              <FieldLabel htmlFor="grant-amount">Amount (USD)</FieldLabel>
              <FieldContent>
                <Input
                  id="grant-amount"
                  type="number"
                  required
                  step="0.01"
                  min={-1000}
                  max={1000}
                  placeholder="e.g. 20 or -5"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </FieldContent>
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="grant-note">Note (optional)</FieldLabel>
              <FieldContent>
                <Input
                  id="grant-note"
                  type="text"
                  maxLength={500}
                  placeholder="e.g. goodwill for failed generations"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </FieldContent>
            </Field>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
              <Button type="submit" loading={grant.isPending}>
                Grant
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
};
