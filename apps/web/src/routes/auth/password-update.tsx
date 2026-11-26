import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";

import { UpdatePasswordForm } from "@/components/auth/auth-form";

const passwordUpdateSearchSchema = z.object({
  error: z.string().optional(),
  token: z.string().optional(),
});

const InvalidLink = () => (
  <p className="text-muted-foreground text-center text-sm">
    This reset link has expired or was already used.{" "}
    <Link to="/auth/password-reset" className="underline">
      Send a new one
    </Link>
  </p>
);

const PasswordUpdatePage = () => {
  const { error, token } = Route.useSearch();

  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-lg font-light">Update your Password</h1>
      </div>
      {token !== undefined && token !== "" && (error === undefined || error === "") ? (
        <UpdatePasswordForm token={token} />
      ) : (
        <InvalidLink />
      )}
    </div>
  );
};

export const Route = createFileRoute("/auth/password-update")({
  component: PasswordUpdatePage,
  head: () => ({ meta: [{ title: "Update Password" }] }),
  validateSearch: passwordUpdateSearchSchema,
});
