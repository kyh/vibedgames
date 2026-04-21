import { useRouterState } from "@tanstack/react-router";

export const usePathname = () =>
  useRouterState({ select: (s) => s.location.pathname });

export const useGameParam = () =>
  useRouterState({
    select: (s) => (s.location.search as { game?: string }).game,
  });
