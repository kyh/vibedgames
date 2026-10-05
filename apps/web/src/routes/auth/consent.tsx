import { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";

import { OAuthConsent } from "@/components/auth/oauth-consent";

const consentSearchSchema = z.looseObject({
  client_id: z.string(),
  scope: z.string().default(""),
});

const ConsentPage = () => {
  const { client_id: clientId, scope } = Route.useSearch();
  return (
    <div className="mx-auto flex w-full flex-col sm:w-[350px]">
      <OAuthConsent clientId={clientId} scope={scope} />
    </div>
  );
};

export const Route = createFileRoute("/auth/consent")({
  component: ConsentPage,
  head: () => ({ meta: [{ title: "Connect an app" }] }),
  validateSearch: consentSearchSchema,
});
