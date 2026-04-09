import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@repo/api/auth/auth";

import { CliAuthRedirect } from "./_components/cli-auth-redirect";

export const metadata: Metadata = {
  title: "Authorize CLI",
};

type PageProps = {
  searchParams: Promise<{ port?: string; state?: string }>;
};

const Page = async (props: PageProps) => {
  const searchParams = await props.searchParams;
  const port = searchParams.port;
  const state = searchParams.state;

  if (!port || !state) {
    return (
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
        <div className="text-center">
          <h1 className="text-lg font-light">Invalid request</h1>
          <p className="text-muted-foreground text-sm">Missing required parameters.</p>
        </div>
      </div>
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(`/auth/cli?port=${port}&state=${state}`)}`);
  }

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("better-auth.session_token");

  if (!sessionCookie?.value) {
    return (
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
        <div className="text-center">
          <h1 className="text-lg font-light">Session error</h1>
          <p className="text-muted-foreground text-sm">Could not read session. Please try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <CliAuthRedirect
        port={port}
        state={state}
        token={sessionCookie.value}
        userName={session.user.name}
      />
    </div>
  );
};

export default Page;
