import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";

export const CONTACT_URL = "https://github.com/kyh/vibedgames/issues";

interface LegalPageProps {
  title: string;
  updated: string;
  children: ReactNode;
}

export const LegalPage = ({ title, updated, children }: LegalPageProps) => (
  <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:py-24">
    <Link to="/" className="text-muted-foreground font-mono text-xs hover:text-foreground">
      ← vibedgames
    </Link>
    <h1 className="mt-6 text-3xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-5xl">
      {title}
    </h1>
    <p className="text-muted-foreground mt-3 font-mono text-xs">Last updated {updated}</p>
    <div className="mt-10 flex flex-col gap-10 text-sm leading-relaxed text-pretty [&_code]:whitespace-nowrap">
      {children}
    </div>
  </main>
);

interface LegalSectionProps {
  heading: string;
  children: ReactNode;
}

export const LegalSection = ({ heading, children }: LegalSectionProps) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-lg font-medium -tracking-[0.02em]">{heading}</h2>
    <div className="text-muted-foreground flex flex-col gap-3 [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_li]:ml-4 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5">
      {children}
    </div>
  </section>
);
