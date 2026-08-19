import { useRouterState } from "@tanstack/react-router";

export const usePathname = () => useRouterState({ select: (s) => s.location.pathname });

export const useGameParam = () =>
  useRouterState({
    // SAFETY: the root route has no validateSearch, so search is untyped; the
    // only read is the optional `game` key, consumed defensively as a string.
    select: (s) => (s.location.search as { game?: string }).game,
  });
