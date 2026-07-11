// Tiny game state: status machine + score + lines. Pure data, no renderer or
// persistence coupling — game-over is a state event here, the collapse is
// purely cosmetic on top of it.

// No "paused" here: pausing is the wrapper's (@repo/embed) state — main.ts
// freezes by skipping update(), the engine status stays "playing" beneath it.
export type Status = "title" | "playing" | "collapsing" | "gameOver";

export class GameState {
  status: Status = "title";
  score = 0;
  lines = 0;

  reset(): void {
    this.score = 0;
    this.lines = 0;
  }

  addScore(points: number): void {
    if (this.status !== "playing") return;
    this.score += points;
  }
}
