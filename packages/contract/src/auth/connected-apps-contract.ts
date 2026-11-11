import { z } from "zod";

import { sessionOnlyBase } from "../base";
import { documented } from "../openapi";
import { revokeConnectedAppInput } from "./connected-apps-schema";

const connectedApp = z.object({
  clientId: z.string(),
  connectedAt: z.date().nullable(),
  name: z.string().nullable(),
  scopes: z.array(z.string()),
  uri: z.string().nullable(),
});

/**
 * The apps a person has connected over OAuth (MCP connectors, `vg login`,
 * and anything else that asked for consent), and the way to cut one off.
 */
export const connectedAppsContract = {
  list: sessionOnlyBase
    .meta(
      documented({
        description:
          "Lists the apps the caller has approved over OAuth, consented to or still holding a refresh token (as `vg login` does), with the scopes each was granted. Needs a real session.",
        summary: "List connected apps",
      }),
    )
    .output(z.object({ apps: z.array(connectedApp) })),

  revoke: sessionOnlyBase
    .meta(
      documented({
        description:
          "Disconnects an app: deletes the caller's consent to it and every refresh token it holds, so it can mint no further access. An access token it already holds lasts until it expires, at most an hour. Needs a real session.",
        errors: [404],
        summary: "Disconnect an app",
      }),
    )
    .input(revokeConnectedAppInput)
    .output(z.object({ clientId: z.string() })),
};
