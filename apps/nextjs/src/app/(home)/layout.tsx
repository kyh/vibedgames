export const dynamic = "force-dynamic";

type LayoutProps = {
  children: React.ReactNode;
};

const Layout = (props: LayoutProps) => {
  return (
    <main className="grid h-dvh w-dvw overflow-hidden">{props.children}</main>
  );
};

export default Layout;
