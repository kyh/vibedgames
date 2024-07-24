import { redirect } from "next/navigation";
import { If } from "@init/ui/if";

import { api } from "@/trpc/server";
import { AccountInvitationsTable } from "./_components/invitations/account-invitations-table";
import { AccountMembersTable } from "./_components/members/account-members-table";
import { InviteMembersDialogContainer } from "./_components/members/invite-members-dialog-container";

type Params = {
  account: string;
};

const Page = async ({ params }: { params: Params }) => {
  const { account, user } = await api.team.teamWorkspace({
    slug: params.account,
  });

  if (!account) {
    return redirect("/dashboard");
  }

  await api.team.members.prefetch({ slug: params.account });
  await api.team.invitations.prefetch({ slug: params.account });

  const canManageRoles = account.permissions.includes("roles.manage");
  const canManageInvitations = account.permissions.includes("invites.manage");

  const isPrimaryOwner = account.primaryOwnerUserId === user.id;
  const currentUserRoleHierarchy = account.roleHierarchyLevel;

  return (
    <section className="divide-y divide-border">
      <div className="grid max-w-7xl grid-cols-1 gap-x-8 gap-y-10 py-8 md:grid-cols-3">
        <div>
          <h2 className="text-base font-light leading-7 text-primary">
            Members
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Here you can manage the members of your team.
          </p>
        </div>
        <div className="md:col-span-2">
          <div className="space-y-4">
            <InviteMembersDialogContainer
              userRoleHierarchy={currentUserRoleHierarchy}
              accountSlug={account.slug}
            />
            <AccountMembersTable
              slug={account.slug}
              userRoleHierarchy={currentUserRoleHierarchy}
              currentUserId={user.id}
              currentAccountId={account.id}
              isPrimaryOwner={isPrimaryOwner}
              canManageRoles={canManageRoles}
            />
          </div>
        </div>
      </div>
      <If condition={canManageInvitations}>
        <div className="grid max-w-7xl grid-cols-1 gap-x-8 gap-y-10 py-8 md:grid-cols-3">
          <div>
            <h2 className="text-base font-light leading-7 text-primary">
              Pending Invites
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Here you can manage the pending invitations to your team.
            </p>
          </div>
          <div className="md:col-span-2">
            <AccountInvitationsTable
              slug={params.account}
              permissions={{
                canUpdateInvitation: canManageRoles,
                canRemoveInvitation: canManageRoles,
                currentUserRoleHierarchy,
              }}
            />
          </div>
        </div>
      </If>
    </section>
  );
};

export default Page;
