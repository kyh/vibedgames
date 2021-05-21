import { useContext, useEffect, useRef, createContext, ReactNode } from "react";
import { Presence } from "phoenix";
import { useDispatch, useSelector } from "react-redux";
import { useHistory, useLocation } from "react-router-dom";
import { useAlert } from "react-alert";
import { useChannel } from "utils/socketUtils";
import { gameActions } from "features/game/gameSlice";
import { RootState } from "app/rootReducer";

export const GameContext = createContext({
  broadcast: (_eventName: string, _payload?: any) => {},
});

type Props = { gameId?: string; children?: ReactNode };

const PRESENCE_EVENTS = {
  state: "presence_state",
  diff: "presence_diff",
};

export const GameProvider = ({ children, gameId }: Props) => {
  const state = useSelector((state: RootState) => state.game);
  const presencesRef = useRef({});
  const history = useHistory();
  const location = useLocation();
  const alert = useAlert();
  const dispatch = useDispatch();
  const { broadcast, connected, error } = useChannel(
    `game:${gameId}`,
    {
      name: localStorage.getItem("name"),
      isHost: location.pathname.includes("spectate"),
    },
    (event, payload) => {
      if (event === PRESENCE_EVENTS.state || event === PRESENCE_EVENTS.diff) {
        if (event === PRESENCE_EVENTS.state) {
          presencesRef.current = payload;
        } else {
          presencesRef.current = Presence.syncDiff(
            presencesRef.current,
            payload
          );
        }
        const players = Presence.list(presencesRef.current)
          .map((p) => p.metas[0])
          .filter((p) => !p.isHost);
        dispatch({ type: "game/players", payload: { players } });
      } else {
        dispatch({ type: event, payload });
      }
    }
  );

  useEffect(() => {
    if (!state.gameId && gameId) {
      dispatch(gameActions.new_game({ gameId }));
    }
    if (error) {
      dispatch(gameActions.reset());
      alert.show(`Error connecting to game ${gameId}`);
      history.push("/");
    }
  }, [state.gameId, gameId, error]);

  if (!connected) return null;
  return (
    <GameContext.Provider value={{ broadcast }}>
      {children}
    </GameContext.Provider>
  );
};

export const useGameChannel = () => {
  return useContext(GameContext);
};
