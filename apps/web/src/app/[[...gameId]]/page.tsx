import { HydrateClient, prefetch, trpc } from "@/trpc/server";
import { PageClient } from "./page.client";

type PageProps = {
  params: Promise<{ gameId?: string[] }>;
};

const Page = async (props: PageProps) => {
  const params = await props.params;
  const gameId = params.gameId?.[0];

  // Prefetch build data on the server when gameId is present
  if (gameId) {
    const getBuildQuery = trpc.localGame.getBuild.queryOptions({ buildId: gameId });
    prefetch(getBuildQuery);
  }

  return (
    <HydrateClient>
      <PageClient />
    </HydrateClient>
  );
};

export default Page;
