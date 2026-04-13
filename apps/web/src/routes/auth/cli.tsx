import { z } from "zod";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getServerContext } from "@/auth/server";
import { CliAuthConfirm } from "@/components/auth/cli-auth-confirm";

const cliSearchSchema = z.object({
  code: z.string().optional(),
});

const fetchCliAuth = createServerFn({ method: "GET" })
  .inputValidator(cliSearchSchema)
  .handler(async ({ data: { code } }) => {
    if (!code) {
      return { error: "missing-code" as const };
    }

    const { auth } = getServerContext();
    const headers = new Headers(getRequestHeaders());
    const session = await auth.api.getSession({ headers });

    if (!session) {
      throw redirect({
        to: "/auth/login",
        search: {
          callbackUrl: `/auth/cli?code=${code}`,
        },
      });
    }

    return {
      error: undefined,
      code,
      userName: session.user.name,
    };
  });

export const Route = createFileRoute("/auth/cli")({
  head: () => ({ meta: [{ title: "Authorize CLI" }] }),
  validateSearch: cliSearchSchema,
  loaderDeps: ({ search }) => ({ code: search.code }),
  loader: ({ deps }) => fetchCliAuth({ data: deps }),
  component: CliAuthPage,
});

function CliAuthPage() {
  const data = Route.useLoaderData();

  if (data.error === "missing-code") {
    return (
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
        <div className="text-center">
          <h1 className="text-lg font-light">Invalid request</h1>
          <p className="text-muted-foreground text-sm">
            Missing authorization code. Run <code>vg login</code> to start.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <CliAuthConfirm code={data.code} userName={data.userName} />
    </div>
  );
}
