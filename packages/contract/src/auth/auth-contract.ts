import { z } from "zod";

import { adminBase, protectedBase, publicBase, sessionOnlyBase } from "../base";
import { documented } from "../openapi";
import { codeInput, createInvitesInput, updateInviteInput } from "./auth-schema";

const okOutput = z.object({ ok: z.literal(true) });

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
  cliConfirm: sessionOnlyBase
    .meta(
      documented({
        description:
          "Approves a pending CLI device code from a signed-in browser, handing the CLI this session's token on its next cliPoll.",
        errors: [404],
        summary: "Confirm a CLI login code",
      }),
    )
    .input(codeInput)
    .output(okOutput),

  cliInit: publicBase
    .meta(
      documented({
        description:
          "Starts the CLI device-code login: returns a short code, valid for five minutes, for the person to confirm in a browser. Poll cliPoll with it.",
        summary: "Start a CLI login",
      }),
    )
    .output(z.object({ code: z.string() })),

  cliPoll: publicBase
    .meta(
      documented({
        description:
          "Polls a CLI login code. Returns `pending` until confirmed, then `confirmed` with a bearer token exactly once; `expired` after five minutes or once consumed.",
        summary: "Poll a CLI login",
      }),
    )
    .input(codeInput)
    .output(
      z.discriminatedUnion("status", [
        z.object({ status: z.literal("expired") }),
        z.object({ status: z.literal("pending") }),
        z.object({ status: z.literal("confirmed"), token: z.string() }),
      ]),
    ),

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
    .meta(
      documented({
        description:
          "Returns the authenticated identity, whether the caller used a session cookie, a session token or an API key. Backs `vg whoami`.",
        summary: "Get the current user",
      }),
    )
    .output(
      z.object({
        email: z.string(),
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
