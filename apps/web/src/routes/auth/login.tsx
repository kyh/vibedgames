import { createFileRoute, Link } from "@tanstack/react-router";

import { LoginForm } from "@/components/auth/auth-form";

export const Route = createFileRoute("/auth/login")({
  head: () => ({ meta: [{ title: "Login" }] }),
  component: LoginPage,
});

function LoginPage() {
  const { callbackUrl } = Route.useSearch();

  return (
    <div className="mx-auto flex w-full flex-col sm:w-[350px]">
      <div className="space-y-6">
        <div className="flex flex-col text-center">
          <h1 className="text-lg font-light">Welcome back</h1>
        </div>
        <LoginForm callbackUrl={callbackUrl} />
      </div>
      <p className="text-muted-foreground mt-6 px-8 text-center text-xs">
        Don't have an account?{" "}
        <Link to="/auth/register" className="underline">
          Register
        </Link>
      </p>
    </div>
  );
}
