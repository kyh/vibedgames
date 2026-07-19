import { Link } from "@tanstack/react-router";

import { authClient } from "@/auth/client";
import { GitHubIcon, XIcon } from "@/components/ui/brand-icons";
import { FadeInBlur } from "@/components/ui/fade-in-blur";

const GITHUB_URL = "https://github.com/kyh/vibedgames";
const X_URL = "https://x.com/kaiyuhsu";

// Top-right entry point, mirroring the bottom-left Nav. Signed-out visitors
// get Register; signed-in users get their dashboard. Session resolves
// client-side after mount — Register is the placeholder while it loads, so
// the link never pops in from nothing.
export const RegisterLink = () => {
  const session = authClient.useSession();
  const signedIn = session.data !== null && !session.isPending;

  return (
    <FadeInBlur className="absolute top-0 right-0 z-10 flex items-center gap-4 px-4 pt-8 sm:pt-6">
      {signedIn ? (
        <Link
          to="/home"
          className="text-muted-foreground hover:text-foreground font-mono text-xs transition"
        >
          Home
        </Link>
      ) : (
        <Link
          to="/auth/register"
          className="text-muted-foreground hover:text-foreground font-mono text-xs transition"
        >
          Register
        </Link>
      )}
    </FadeInBlur>
  );
};

// Bottom-right, aligned right with RegisterLink and bottom with the Nav.
export const GitHubLink = () => (
  <FadeInBlur className="fixed right-0 bottom-0 z-10 flex items-center gap-4 px-4 py-6">
    <a
      href={X_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="X"
      className="text-muted-foreground hover:text-foreground py-1.5 transition"
    >
      <XIcon className="size-4" />
    </a>
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="GitHub"
      className="text-muted-foreground hover:text-foreground py-1.5 transition"
    >
      <GitHubIcon className="size-4" />
    </a>
  </FadeInBlur>
);
