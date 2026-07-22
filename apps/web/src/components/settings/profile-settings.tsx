import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { toast } from "@repo/ui/components/sonner";

import type { ShellUser } from "@/components/account/account-shell";
import { authClient } from "@/auth/client";

/** Name is editable via better-auth; email is identity, shown read-only. */
export const ProfileSettings = ({ user }: { user: ShellUser }) => {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);

  const trimmed = name.trim();
  const dirty = trimmed !== "" && trimmed !== user.name;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setSaving(true);
    const { error } = await authClient.updateUser({ name: trimmed });
    setSaving(false);
    if (error) {
      toast.error(error.message ?? "Couldn't update name");
      return;
    }
    toast.success("Name updated");
    // Re-runs the _account beforeLoad so route context (and the shell's
    // avatar initials) pick up the new name.
    await router.invalidate();
  };

  return (
    <section
      id="profile"
      className="grid scroll-mt-28 grid-cols-1 gap-x-8 gap-y-6 py-12 first:pt-0 last:pb-0 md:grid-cols-3"
    >
      <header>
        <h2 className="text-base font-semibold">Profile</h2>
        <p className="text-muted-foreground mt-1 text-sm">Who you are on Vibedgames.</p>
      </header>

      <form
        onSubmit={(e) => void save(e)}
        className="bg-input/40 space-y-4 rounded-md p-4 backdrop-blur-sm md:col-span-2"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field className="gap-1">
            <FieldLabel htmlFor="profile-name">Name</FieldLabel>
            <FieldContent>
              <Input
                id="profile-name"
                type="text"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FieldContent>
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="profile-email">Email</FieldLabel>
            <FieldContent>
              <Input
                id="profile-email"
                type="email"
                readOnly
                aria-readonly
                className="text-muted-foreground font-mono"
                value={user.email}
              />
            </FieldContent>
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
            Save
          </Button>
        </div>
      </form>
    </section>
  );
};
