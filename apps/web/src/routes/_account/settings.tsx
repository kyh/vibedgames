import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ApiKeySettings } from "@/components/settings/api-key-settings";
import { CreditsSettings } from "@/components/settings/credits-settings";
import { ProfileSettings } from "@/components/settings/profile-settings";

/**
 * Stacked side-by-side sections: each is a `md:grid-cols-3` grid — heading +
 * description in the first column, content spanning the other two — divided
 * by hairlines. Section roots share the `settings-section` layout classes
 * defined in each component.
 */
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
        <CreditsSettings
          code={code}
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
    // A credit code from a shared link, prefilled into the redeem field.
    code: z.string().optional(),
    // Set by Stripe's redirect after a paid checkout (credits.checkout).
    purchase: z.string().optional(),
  }),
});
