import { createFileRoute, Link } from "@tanstack/react-router";

import { AuthForm } from "@/components/auth/auth-form";

export const Route = createFileRoute("/auth/register")({
  head: () => ({ meta: [{ title: "Register" }] }),
  component: () => (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div className="flex flex-col text-center">
        <h1 className="text-lg font-light">Create an account</h1>
        <p className="text-muted-foreground text-sm">
          New accounts are currently{" "}
          <a className="underline" href="https://x.com/kaiyuhsu" target="_blank" rel="noreferrer">
            invite only
          </a>
          .
        </p>
      </div>
      <AuthForm type="register" />
      <p className="text-muted-foreground px-8 text-center text-sm">
        Already have an account?{" "}
        <Link to="/auth/login" className="underline">
          Login
        </Link>
      </p>
    </div>
  ),
});
