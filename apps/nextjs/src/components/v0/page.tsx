import { Composer } from "./composer";
import { Preview } from "./preview";
import { V0Provider } from "./v0-provider";

const Page = () => {
  return (
    <V0Provider>
      <main className="grid h-dvh w-dvw overflow-hidden bg-[url('https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/bg.png')] bg-[size:10px]">
        <Preview />
        <Composer />
      </main>
    </V0Provider>
  );
};

export default Page;
