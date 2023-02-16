import { useRouter } from "next/router";
import { ButtonLinkNative, Spinner } from "~/components";
import { Content } from "~/lib/packs/components/Page";
import { PackSection, Pack } from "~/lib/packs/components/Packs";
import { useGetPacks } from "~/lib/packs/usePackActions";
import { useAuth } from "~/lib/auth/useAuth";

export const Profile = () => {
  const auth = useAuth();
  const router = useRouter();
  const username = router.query.username as string;
  const res = useGetPacks({ username });

  if (!res.data) return <Spinner />;

  const isMyPage = username === auth.user?.user_metadata.username;

  return (
    <Content>
      <header className="flex justify-between items-center mb-5">
        <h1>@{username}&apos;s packs</h1>
        {isMyPage && (
          <ButtonLinkNative href="/packs/new">Create new Pack</ButtonLinkNative>
        )}
      </header>
      <PackSection>
        <div className="pack-items">
          {res.data.map((pack) => (
            <Pack
              key={pack.id}
              pack={pack}
              showEditButton={isMyPage}
              showPlayButton={!isMyPage}
            />
          ))}
        </div>
      </PackSection>
    </Content>
  );
};
