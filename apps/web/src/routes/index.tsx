import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-light tracking-tight">vibedgames</h1>
      <p className="text-muted-foreground mt-3 text-sm">
        Deploy HTML games to your own subdomain.
      </p>
      <pre className="bg-muted/50 mt-8 rounded-md px-4 py-3 text-left text-xs">
        <code>{`# Install the CLI
npm i -g vibedgames

# Authenticate
vg login

# Deploy any directory containing index.html
vg deploy ./dist

# → https://your-slug.vibedgames.com`}</code>
      </pre>
    </main>
  );
}
