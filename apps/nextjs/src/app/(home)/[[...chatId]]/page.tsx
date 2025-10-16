import { Composer } from "../_components/composer";
import { Preview } from "../_components/preview";
import { V0Provider } from "../_components/v0-provider";

export const dynamic = "force-dynamic";

const Page = () => {
  return (
    <V0Provider>
      <main className="grid h-dvh w-dvw overflow-hidden">
        <Preview />
        <Composer />
      </main>
    </V0Provider>
  );
};

export default Page;
