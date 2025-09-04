import { Composer } from "../_components/composer";
import { Preview } from "../_components/preview";
import { StreamingProvider } from "../_components/stream-provider";

export const dynamic = "force-dynamic";

const Page = () => {
  return (
    <StreamingProvider>
      <main className="grid h-dvh w-dvw overflow-hidden">
        <Preview />
        <Composer />
      </main>
    </StreamingProvider>
  );
};

export default Page;
