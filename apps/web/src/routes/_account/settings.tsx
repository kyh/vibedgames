import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ApiKeySettings } from "@/components/settings/api-key-settings";
import { ConnectedAppsSettings } from "@/components/settings/connected-apps-settings";
import { CreditsSettings } from "@/components/settings/credits-settings";
import { ProfileSettings } from "@/components/settings/profile-settings";

const SettingsPage = () => {
  const { user } = Route.useRouteContext();
  const { code, purchase } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div>
      <h1 className="sr-only">Settings</h1>
      <div className="divide-y divide-white/10">
        <ProfileSettings user={user} />
        <ApiKeySettings />
        <ConnectedAppsSettings />
        <CreditsSettings
          code={code}
          email={user.email}
          purchase={purchase === "success"}
          onCodeRedeemed={() => {
            if (code) {
              void navigate({ replace: true, search: (prev) => ({ ...prev, code: undefined }) });
            }
          }}
        />
      </div>
    </div>
  );
};

export const Route = createFileRoute("/_account/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings — Vibedgames" }] }),
  validateSearch: z.object({
    code: z.string().optional(),
    purchase: z.string().optional(),
  }),
});
