import { z } from "zod";

import { adminBase, protectedBase, requiresScope } from "../base";
import { documented } from "../openapi";
import { createInvitesInput, updateInviteInput } from "./auth-schema";

const inviteCodeRow = z.object({
  code: z.string(),
  createdAt: z.date(),
  createdBy: z.string().nullable(),
  creditMicro: z.number().int().describe("Credit one redemption grants, in micro-USD."),
  expiresAt: z.date().nullable(),
  id: z.string(),
  maxUses: z.number().int().nullable().describe("null means unlimited uses."),
  note: z.string().nullable(),
  revokedAt: z.date().nullable(),
  usedCount: z.number().int(),
});

export const authContract = {
  createInvites: adminBase
    .meta(
      documented({
        description:
          "Creates one custom credit code or a batch of random ones, each worth `creditUsd` per redemption. Admin only; 409 when a custom code already exists.",
        errors: [409],
        summary: "Create credit codes",
      }),
    )
    .input(createInvitesInput)
    .output(z.object({ codes: z.array(inviteCodeRow) })),

  listInvites: adminBase
    .meta(
      documented({
        description: "Lists every credit code, newest first, with its creator's email. Admin only.",
        summary: "List credit codes",
      }),
    )
    .output(
      z.object({ codes: z.array(inviteCodeRow.extend({ creatorEmail: z.string().nullable() })) }),
    ),

  me: protectedBase
    .meta(requiresScope("profile"))
    .meta(
      documented({
        description:
          "Returns the authenticated identity, whether the caller used a session cookie, a session token, an API key or an OAuth token. An OAuth token sees `email` only with the `email` scope, and `role` never. Backs `vg whoami`.",
        summary: "Get the current user",
      }),
    )
    .output(
      z.object({
        email: z.string().nullable(),
        id: z.string(),
        name: z.string(),
        role: z.string().nullable(),
      }),
    ),

  updateInvite: adminBase
    .meta(
      documented({
        description:
          "Revokes, un-revokes, or changes the use limit or value of a credit code. Omitted fields are left untouched. Admin only.",
        errors: [404],
        summary: "Update a credit code",
      }),
    )
    .input(updateInviteInput)
    .output(z.object({ code: inviteCodeRow })),
};
