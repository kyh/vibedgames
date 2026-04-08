import { createFileRoute, Link } from "@tanstack/react-router";

import { RequestPasswordResetForm } from "@/app/(auth)/_components/auth-form";

export const Route = createFileRoute("/auth/password-reset")({
  head: () => ({ meta: [{ title: "Reset Password" }] }),
  component: () => (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-lg font-light">Reset your Password</h1>
      </div>
      <RequestPasswordResetForm />
      <p className="text-muted-foreground px-8 text-center text-sm">
        Back to{" "}
        <Link to="/auth/login" className="underline">
          Login
        </Link>
      </p>
    </div>
  ),
});
