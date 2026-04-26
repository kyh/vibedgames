import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, createTRPCRouter } from "../trpc";

/**
 * Admin user management. Wraps better-auth's admin plugin endpoints so the
 * web app can list / create users without exposing the full admin API
 * surface to the client. The plugin endpoints re-verify the admin role from
 * the forwarded session headers, on top of our `adminProcedure` check.
 */
export const adminRouter = createTRPCRouter({
  users: createTRPCRouter({
    list: adminProcedure.query(async ({ ctx }) => {
      const result = await ctx.auth.api.listUsers({
        query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" },
        headers: ctx.headers,
      });
      return result;
    }),

    create: adminProcedure
      .input(
        z.object({
          email: z.email(),
          password: z.string().min(8),
          name: z.string().min(1).max(100),
          role: z.enum(["user", "admin"]).default("user"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          const result = await ctx.auth.api.createUser({
            body: {
              email: input.email,
              password: input.password,
              name: input.name,
              role: input.role,
            },
            headers: ctx.headers,
          });
          return result;
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: err instanceof Error ? err.message : "Failed to create user",
          });
        }
      }),
  }),
});
