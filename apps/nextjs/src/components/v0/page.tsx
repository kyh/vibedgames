import { Composer } from "./composer";
import { Preview } from "./preview";
import { V0Provider } from "./v0-provider";

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
