export interface PollerOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

/** Runs read-only refreshes only. Executing actions must never be passed here. */
export class ForegroundPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private foreground = true;
  private online = true;
  private running = false;
  private refreshPending = false;
  private generation = 0;
  private readonly intervalMs: number;

  constructor(private readonly task: () => Promise<void>, private readonly options: PollerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 8_000;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1) throw new Error('轮询间隔无效');
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    this.requestRefresh();
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.refreshPending = false;
    this.clearTimer();
  }

  setForeground(value: boolean): void {
    if (this.foreground === value) return;
    this.foreground = value;
    this.changedAvailability();
  }

  setOnline(value: boolean): void {
    if (this.online === value) return;
    this.online = value;
    this.changedAvailability();
  }

  refresh(): void { this.requestRefresh(); }

  private get available(): boolean { return this.started && this.foreground && this.online; }

  private changedAvailability(): void {
    this.clearTimer();
    if (this.available) this.requestRefresh();
    else this.refreshPending = false;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private requestRefresh(): void {
    if (!this.available) return;
    this.clearTimer();
    if (this.running) {
      this.refreshPending = true;
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    if (!this.available || this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      await this.task();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
      if (this.available) {
        // A resume while a read was in flight requests one follow-up read.
        if (this.refreshPending || generation !== this.generation) {
          this.refreshPending = false;
          this.requestRefresh();
        } else {
          this.timer = setTimeout(() => { this.timer = undefined; this.requestRefresh(); }, this.intervalMs);
        }
      }
    }
  }
}
