import consola from "consola";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type ProgressEntry = {
  label: string;
  state: "pending" | "running" | "done" | "failed";
  detail?: string;
  startedAt?: number;
};

/**
 * Lightweight per-job progress renderer. When stdout is a TTY this prints
 * a multi-line spinner that updates in place; otherwise it falls back to
 * one-line-per-event logging that still tells the story in CI / pipes.
 */
export class MultiProgress {
  private entries: ProgressEntry[];
  private interval: NodeJS.Timeout | undefined;
  private frame = 0;
  private rendered = 0;

  constructor(labels: string[]) {
    this.entries = labels.map((label) => ({ label, state: "pending" }));
  }

  start(): void {
    if (this.isInteractive()) {
      this.render();
      this.interval = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        this.render();
      }, 100);
    }
  }

  update(index: number, patch: Partial<ProgressEntry>): void {
    const entry = this.entries[index];
    if (!entry) return;
    Object.assign(entry, patch);
    if (patch.state === "running" && entry.startedAt === undefined) {
      entry.startedAt = Date.now();
    }
    if (this.isInteractive()) {
      this.render();
    } else {
      this.logLine(index);
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    if (this.isInteractive()) this.render();
  }

  private isInteractive(): boolean {
    return Boolean(process.stdout.isTTY) && process.env.CI !== "true";
  }

  private logLine(index: number): void {
    const entry = this.entries[index];
    if (!entry) return;
    if (entry.state === "running") {
      consola.start(`${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`);
    } else if (entry.state === "done") {
      consola.success(
        `${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}${this.elapsed(entry)}`,
      );
    } else if (entry.state === "failed") {
      consola.error(
        `${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}${this.elapsed(entry)}`,
      );
    }
  }

  private render(): void {
    if (this.rendered > 0) {
      // Move cursor up `rendered` lines and clear them.
      process.stdout.write(`\x1b[${this.rendered}A`);
      for (let i = 0; i < this.rendered; i++) {
        process.stdout.write("\x1b[2K\x1b[1B");
      }
      process.stdout.write(`\x1b[${this.rendered}A`);
    }
    const lines = this.entries.map((entry) => this.line(entry));
    process.stdout.write(lines.join("\n") + "\n");
    this.rendered = lines.length;
  }

  private line(entry: ProgressEntry): string {
    const icon =
      entry.state === "running"
        ? FRAMES[this.frame]!
        : entry.state === "done"
          ? "✔"
          : entry.state === "failed"
            ? "✘"
            : "·";
    const detail = entry.detail ? ` — ${entry.detail}` : "";
    return `${icon} ${entry.label}${detail}${this.elapsed(entry)}`;
  }

  private elapsed(entry: ProgressEntry): string {
    if (entry.startedAt === undefined) return "";
    if (entry.state !== "done" && entry.state !== "failed") return "";
    const ms = Date.now() - entry.startedAt;
    return ` (${(ms / 1000).toFixed(1)}s)`;
  }
}
