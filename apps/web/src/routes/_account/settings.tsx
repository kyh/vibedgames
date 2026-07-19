import { createFileRoute } from "@tanstack/react-router";

import { ApiKeySettings } from "@/components/settings/api-key-settings";
import { CreditsSettings } from "@/components/settings/credits-settings";

export const Route = createFileRoute("/_account/settings")({
  head: () => ({ meta: [{ title: "Settings — Vibedgames" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <>
      <ApiKeySettings />
      <CreditsSettings />
    </>
  );
}
