import { createFileRoute } from "@tanstack/react-router";

import { UpdatePasswordForm } from "~/app/(auth)/_components/auth-form";

export const Route = createFileRoute("/auth/password-update")({
  head: () => ({ meta: [{ title: "Update Password" }] }),
  component: () => (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-lg font-light">Update your Password</h1>
      </div>
      <UpdatePasswordForm />
    </div>
  ),
});
