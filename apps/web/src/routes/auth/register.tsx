import { createFileRoute, Link } from "@tanstack/react-router";

import { creditCodeCallback, RegisterForm } from "@/components/auth/auth-form";

/**
 * Open signup. A link carrying a credit code (`?invite=`) still works: the
 * code rides through to /settings, which redeems it once the account exists.
 */
const RegisterPage = () => {
  const { callbackUrl, invite } = Route.useSearch();

  return (
    <div className="mx-auto flex w-full flex-col sm:w-[350px]">
      <div className="space-y-6">
        <div className="grid text-center">
          <h1 className="text-lg font-light">Create an account</h1>
          {invite && (
            <p className="text-muted-foreground text-sm">
              Code <span className="text-foreground font-mono">{invite.toUpperCase()}</span> is
              redeemed for credits once you sign up.
            </p>
          )}
        </div>
        <RegisterForm callbackUrl={creditCodeCallback(invite) ?? callbackUrl} />
      </div>
      <p className="text-muted-foreground mt-6 px-8 text-center text-xs">
        Already have an account?{" "}
        <Link to="/auth/login" search={{ callbackUrl, invite }} className="underline">
          Login
        </Link>
      </p>
    </div>
  );
};

export const Route = createFileRoute("/auth/register")({
  component: RegisterPage,
  head: () => ({ meta: [{ title: "Register" }] }),
});
