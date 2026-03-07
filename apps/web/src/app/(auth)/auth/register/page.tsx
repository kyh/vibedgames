import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/app/(auth)/_components/auth-form";

export const metadata: Metadata = {
  title: "Register",
};

const Page = () => {
  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div className="flex flex-col text-center">
        <h1 className="text-lg font-light">Create an account</h1>
        <p className="text-muted-foreground text-sm">
          New accounts are currently{" "}
          <Link
            className="underline"
            href="https://x.com/kaiyuhsu"
            target="_blank"
          >
            invite only
          </Link>
          .
        </p>
      </div>
      <AuthForm type="register" />
      <p className="text-muted-foreground px-8 text-center text-sm">
        Already have an account?{" "}
        <Link href="/auth/login" className="underline">
          Login
        </Link>
      </p>
    </div>
  );
};

export default Page;
