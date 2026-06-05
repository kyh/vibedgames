import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { RegisterForm } from "@/components/auth/auth-form";

function RegisterPage() {
  const [verifiedCode, setVerifiedCode] = useState<string | null>(null);

  return (
    <div className="mx-auto flex w-full flex-col sm:w-[350px]">
      <div className="space-y-6">
        {verifiedCode === null ? (
          <div className="flex flex-col text-center">
            <h1 className="text-lg font-light">Create an account</h1>
            <p className="text-muted-foreground text-sm">
              Early preview — an{" "}
              <a
                className="underline"
                href="https://x.com/kaiyuhsu"
                target="_blank"
                rel="noreferrer"
              >
                invite code
              </a>{" "}
              is required to sign up.
            </p>
          </div>
        ) : null}
        <RegisterForm verifiedCode={verifiedCode} onVerifiedCodeChange={setVerifiedCode} />
      </div>
      <p className="text-muted-foreground mt-6 px-8 text-center text-xs">
        Already have an account?{" "}
        <Link to="/auth/login" className="underline">
          Login
        </Link>
      </p>
    </div>
  );
}

export const Route = createFileRoute("/auth/register")({
  head: () => ({ meta: [{ title: "Register" }] }),
  component: RegisterPage,
});
