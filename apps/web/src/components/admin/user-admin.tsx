import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { toast } from "@repo/ui/components/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "@/lib/trpc";

const initialForm = {
  email: "",
  password: "",
  name: "",
  role: "user" as "user" | "admin",
};

export const UserAdmin = () => {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const list = useQuery(trpc.admin.users.list.queryOptions());
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

  const [form, setForm] = useState(initialForm);

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-2xl font-light">Users</h2>
        <p className="text-muted-foreground text-sm">
          Create accounts directly — no invite code needed.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(form);
        }}
        className="grid grid-cols-1 gap-3 rounded-md border border-white/10 p-4 sm:grid-cols-4"
      >
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
              onChange={(e) =>
                setForm((f) => ({ ...f, role: e.target.value as "user" | "admin" }))
              }
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </FieldContent>
        </Field>
        <div className="sm:col-span-4">
          <Button loading={create.isPending}>Create user</Button>
        </div>
      </form>

      <div>
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Existing users
        </h3>
        {list.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
        {list.data?.users.length === 0 && (
          <p className="text-muted-foreground text-sm">No users yet.</p>
        )}
        <ul className="divide-y divide-white/10 rounded-md border border-white/10">
          {list.data?.users.map((u) => (
            <li key={u.id} className="flex items-center gap-3 p-3 text-sm">
              <span className="font-mono">{u.email}</span>
              <span className="text-muted-foreground">{u.name}</span>
              {u.role === "admin" && (
                <span className="rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-200">
                  admin
                </span>
              )}
              {u.banned && (
                <span className="rounded bg-red-900/40 px-2 py-0.5 text-xs text-red-200">
                  banned
                </span>
              )}
              <span className="text-muted-foreground ml-auto text-xs">
                {new Date(u.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};
