import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/app/(auth)/_components/auth-form";

export const metadata: Metadata = {
  title: "Login",
};

const Page = () => {
  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div className="flex flex-col text-center">
        <h1 className="text-lg font-light">Welcome back</h1>
      </div>
      <AuthForm type="login" />
      <p className="text-muted-foreground px-8 text-center text-sm">
        Don't have an account?{" "}
        <Link href="/auth/register" className="underline">
          Register
        </Link>
      </p>
    </div>
  );
};

export default Page;
