import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@repo/ui/logo";

export const metadata: Metadata = {
  title: "Authentication",
  description: "Authentication forms built using the components.",
};

type LayoutProps = {
  children: React.ReactNode;
};

const Layout = (props: LayoutProps) => (
  <div className="relative container grid min-h-dvh flex-col items-center justify-center lg:max-w-none lg:grid-cols-2 lg:px-0">
    <div className="bg-muted relative hidden h-full flex-col px-8 py-4 text-white md:py-10 lg:flex dark:border-r">
      <div className="absolute inset-0 bg-zinc-900" />
      <Link className="relative z-20 flex items-center" href="/">
        <Logo className="w-8" />
      </Link>
      <div className="relative z-20 mt-auto">
        <blockquote className="space-y-2">
          <p className="text-lg">
            &ldquo;Aenean consectetur a enim ac posuere. Pellentesque vehicula
            semper blandit. Aliquam maximus ligula quis risus porta, sit amet
            pulvinar mi elementum. Lorem ipsum dolor sit amet, consectetur
            adipiscing elit.&rdquo;
          </p>
          <footer className="text-sm">Lorem Ipsum</footer>
        </blockquote>
      </div>
    </div>
    <div className="lg:p-8">{props.children}</div>
  </div>
);

export default Layout;
