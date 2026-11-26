import { useRouterState } from "@tanstack/react-router";
import { z } from "zod";

const gameParam = z.looseObject({ game: z.string().optional() });

export const usePathname = () => useRouterState({ select: (s) => s.location.pathname });

export const useGameParam = () =>
  useRouterState({
    select: (s) => gameParam.safeParse(s.location.search).data?.game,
  });
