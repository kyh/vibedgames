import { z } from "zod";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequestHeaders } from "@tanstack/react-start/server";

import { getServerContext } from "@/auth/server";
import { CliAuthRedirect } from "@/components/auth/cli-auth-redirect";

// TanStack Router auto-parses numeric query strings to numbers, so accept
// both shapes and coerce to string.
const cliSearchSchema = z.object({
  port: z.coerce.string().optional(),
  state: z.coerce.string().optional(),
});

const fetchCliAuth = createServerFn({ method: "GET" })
  .inputValidator(cliSearchSchema)
  .handler(async ({ data: { port, state } }) => {
    if (!port || !state) {
      return { error: "missing-params" as const };
    }

    const { auth } = getServerContext();
    const headers = new Headers(getRequestHeaders());
    const session = await auth.api.getSession({ headers });

    if (!session) {
      throw redirect({
        to: "/auth/login",
        search: {
          callbackUrl: `/auth/cli?port=${port}&state=${state}`,
        },
      });
    }

    const token = getCookie("better-auth.session_token");
    if (!token) {
      return { error: "no-session" as const };
    }

    return {
      error: undefined,
      port,
      state,
      token,
      userName: session.user.name,
    };
  });

export const Route = createFileRoute("/auth/cli")({
  head: () => ({ meta: [{ title: "Authorize CLI" }] }),
  validateSearch: cliSearchSchema,
  loaderDeps: ({ search }) => ({ port: search.port, state: search.state }),
  loader: ({ deps }) => fetchCliAuth({ data: deps }),
  component: CliAuthPage,
});

function CliAuthPage() {
  const data = Route.useLoaderData();

  if (data.error === "missing-params") {
    return (
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
        <div className="text-center">
          <h1 className="text-lg font-light">Invalid request</h1>
          <p className="text-muted-foreground text-sm">
            Missing required parameters.
          </p>
        </div>
      </div>
    );
  }

  if (data.error === "no-session") {
    return (
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
        <div className="text-center">
          <h1 className="text-lg font-light">Session error</h1>
          <p className="text-muted-foreground text-sm">
            Could not read session. Please try again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <CliAuthRedirect
        port={data.port}
        state={data.state}
        token={data.token}
        userName={data.userName}
      />
    </div>
  );
}
