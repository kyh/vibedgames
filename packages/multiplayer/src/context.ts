import { createContext } from "react";

import type { MultiplayerContextValue } from "./types";

export const MultiplayerContext = createContext<
  MultiplayerContextValue<unknown, unknown> | null
>(null);
