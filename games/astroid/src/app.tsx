import { useRef } from "react";
import { useGame } from "./hooks/use-game";
import { MINIMAP_SIZE, WORLD_HEIGHT, WORLD_WIDTH } from "./game/constants";

const App = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const { score, weaponName, alive, respawnCountdown, playerCount } = useGame(
    canvasRef,
    minimapRef,
  );

  return (
    <section className="app-container">
      <canvas ref={canvasRef} className="game-canvas" />

      {/* HUD */}
      <div className="hud">
        <div className="hud-left">
          <div className="hud-score">{score}</div>
          <div className="hud-weapon">{weaponName}</div>
        </div>
        <div className="hud-right">
          <div className="hud-players">{playerCount} players</div>
        </div>
      </div>

      {/* Minimap */}
      <canvas
        ref={minimapRef}
        className="minimap"
        width={MINIMAP_SIZE}
        height={Math.round(MINIMAP_SIZE * (WORLD_HEIGHT / WORLD_WIDTH))}
      />

      {/* Death overlay */}
      {!alive && (
        <div className="death-overlay">
          <div className="death-text">DESTROYED</div>
          {respawnCountdown > 0 && (
            <div className="death-countdown">
              Respawning in {respawnCountdown}...
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default App;
