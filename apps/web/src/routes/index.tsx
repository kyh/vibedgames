import { createFileRoute } from "@tanstack/react-router";

import { PageClient } from "@/app/[[...gameId]]/page.client";

export const Route = createFileRoute("/")({
  component: () => <PageClient />,
});
