import { Composer } from "../_components/composer";
import { Preview } from "../_components/preview";
import { V0Provider } from "../_components/v0-provider";

export const dynamic = "force-dynamic";

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
