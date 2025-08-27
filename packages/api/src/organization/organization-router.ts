import { TRPCError } from "@trpc/server";

import { authMetadataSchema } from "../auth/auth-schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { getOrganizationInput } from "./organization-schema";

export const organizationRouter = createTRPCRouter({
  get: protectedProcedure
    .input(getOrganizationInput)
    .query(async ({ ctx, input }) => {
      const { slug } = input;

      const organization = await ctx.db.query.organization.findFirst({
        where: (org, { eq }) => eq(org.slug, slug),
      });

      if (!organization) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Organization not found",
        });
      }

      const members = await ctx.db.query.member.findMany({
        where: (member, { eq }) => eq(member.organizationId, organization.id),
      });
      const currentUserMember = members.find(
        (member) => member.userId === ctx.session.user.id,
      );

      if (!currentUserMember) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "You are not a member of this organization",
        });
      }

      const invitations = await ctx.db.query.invitation.findMany({
        where: (invitation, { eq }) =>
          eq(invitation.organizationId, organization.id),
      });
      const filteredInvitations = invitations.filter(
        (invitation) => invitation.status !== "canceled",
      );

      const memberUserIds = members.map((member) => member.userId);
      const memberUsers = await ctx.db.query.user.findMany({
        where: (user, { inArray }) => inArray(user.id, memberUserIds),
      });
      const memberUsersMap = new Map(
        memberUsers.map((user) => [user.id, user]),
      );

      const membersWithUsers = members.map((member) => ({
        ...member,
        user: memberUsersMap.get(member.userId),
      }));

      return {
        currentUserMember,
        organization,
        organizationMetadata: authMetadataSchema.parse(
          organization.metadata ?? "{}",
        ),
        members: membersWithUsers,
        invitations: filteredInvitations,
      };
    }),
});
