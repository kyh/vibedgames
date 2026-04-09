import { createFileRoute, Link } from "@tanstack/react-router";

import { AuthForm } from "@/app/(auth)/_components/auth-form";

export const Route = createFileRoute("/auth/login")({
  head: () => ({ meta: [{ title: "Login" }] }),
  component: LoginPage,
});

function LoginPage() {
  const { callbackUrl } = Route.useSearch() as { callbackUrl?: string };

  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div className="flex flex-col text-center">
        <h1 className="text-lg font-light">Welcome back</h1>
      </div>
      <AuthForm type="login" callbackUrl={callbackUrl} />
      <p className="text-muted-foreground px-8 text-center text-sm">
        Don't have an account?{" "}
        <Link to="/auth/register" className="underline">
          Register
        </Link>
      </p>
    </div>
  );
}
