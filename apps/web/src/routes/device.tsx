import { z } from "zod";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { APIError } from "better-auth/api";

import { getServerContext } from "@/auth/server";
import { DeviceApproval } from "@/components/oauth/device-approval";

/**
 * Where `vg login` sends a person to approve a device code (RFC 8628): the
 * CLI prints a user code and opens this page with it filled in, or the
 * person types it. Reading the code here claims it for the signed-in person,
 * so only they can approve or deny it, and the page shows which app asks for
 * what before either.
 */

const deviceSearchSchema = z.object({ user_code: z.string().optional() });

/** As the person typed it: case and separators are theirs, the code is not. */
const normalizeUserCode = (code: string) => code.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");

const fetchDeviceRequest = createServerFn({ method: "GET" })
  .validator(deviceSearchSchema)
  .handler(async ({ data }) => {
    const { auth } = getServerContext();
    const headers = new Headers(getRequestHeaders());
    const session = await auth.api.getSession({ headers });
    const userCode = data.user_code ? normalizeUserCode(data.user_code) : "";
    if (!session) {
      const back = userCode ? `/device?user_code=${userCode}` : "/device";
      throw redirect({ search: { callbackUrl: back }, to: "/auth/login" });
    }
    if (!userCode) {
      return { state: "enter" as const, userName: session.user.name };
    }
    let request;
    try {
      request = await auth.api.deviceVerify({ headers, query: { user_code: userCode } });
    } catch (error) {
      const expired =
        error instanceof APIError && JSON.stringify(error.body ?? {}).includes("expired_token");
      return {
        state: expired ? ("expired" as const) : ("unknown" as const),
        userName: session.user.name,
      };
    }
    if (request.status !== "pending" || !request.client_id) {
      return { state: "used" as const, userName: session.user.name };
    }
    const client = await auth.api
      .getOAuthClientPublic({ headers, query: { client_id: request.client_id } })
      .catch(() => null);
    return {
      clientName: client?.client_name ?? null,
      scopes: (request.scope ?? "").split(" ").filter(Boolean),
      state: "pending" as const,
      userCode,
      userName: session.user.name,
    };
  });

const DevicePage = () => {
  const data = Route.useLoaderData();
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      <div className="mx-auto flex w-full flex-col sm:w-[380px]">
        <DeviceApproval request={data} />
      </div>
    </div>
  );
};

export const Route = createFileRoute("/device")({
  component: DevicePage,
  head: () => ({
    meta: [{ title: "Connect a device" }, { content: "noindex, nofollow", name: "robots" }],
  }),
  loader: ({ deps }) => fetchDeviceRequest({ data: deps }),
  loaderDeps: ({ search }) => ({ user_code: search.user_code }),
  validateSearch: deviceSearchSchema,
});
