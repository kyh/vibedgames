import { Link } from "@tanstack/react-router";

import { FadeInBlur } from "@/components/ui/fade-in-blur";

// Top-right entry point to registration, mirroring the bottom-left Nav.
export const RegisterLink = () => (
  <FadeInBlur className="fixed top-0 right-0 z-10 px-4 py-6">
    <Link
      to="/auth/register"
      className="text-muted-foreground hover:text-foreground font-mono text-xs transition"
    >
      Register
    </Link>
  </FadeInBlur>
);
