import { createFileRoute } from "@tanstack/react-router";

import { PageClient } from "@/components/game/page";

export const Route = createFileRoute("/")({
  component: () => <PageClient />,
});
