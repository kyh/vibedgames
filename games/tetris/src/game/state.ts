export type Status = "title" | "playing" | "collapsing" | "gameOver";

export class GameState {
  status: Status = "title";
  score = 0;
  lines = 0;

  reset() {
    this.score = 0;
    this.lines = 0;
  }

  addScore(points: number) {
    if (this.status !== "playing") {
      return;
    }

    this.score += points;
  }
}
