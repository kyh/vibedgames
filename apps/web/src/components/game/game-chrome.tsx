import { createContext, useContext } from "react";

const GameChromeHiddenContext = createContext(false);

type GameChromeProviderProps = {
  hidden: boolean;
  children: React.ReactNode;
};

export const GameChromeProvider = ({ hidden, children }: GameChromeProviderProps) => (
  <GameChromeHiddenContext.Provider value={hidden}>{children}</GameChromeHiddenContext.Provider>
);

export const useGameChromeHidden = () => useContext(GameChromeHiddenContext);
