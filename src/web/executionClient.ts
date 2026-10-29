import { isExecutionSnapshot, type ExecutionSnapshot } from "../shared/executionTrace.js";

/** Live observations are independent of the explicitly frozen agent inspector. */
export class ExecutionClient {
  sessionId: string | null = null;
  value: ExecutionSnapshot | null = null;
  error: string | null = null;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  constructor(private readonly request: typeof fetch, private readonly onChange: () => void) {}

  watch(id: string | null): void {
    if (id === this.sessionId || this.stopped) return;
    this.controller?.abort(); this.controller = null; this.pending = null;
    this.sessionId = id; this.value = null; this.error = null;
    if (id) void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const id = this.sessionId;
    if (!id || this.stopped) return Promise.resolve();
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    const pending = (async () => {
      try {
        const response = await this.request(`/agents/execution?${new URLSearchParams({ session_id: id })}`, { headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error();
        const value: unknown = await response.json();
        if (!isExecutionSnapshot(value, id)) throw new Error();
        if (this.stopped || this.sessionId !== id || this.controller !== controller || controller.signal.aborted) return;
        if (this.value?.stream_id === value.stream_id && value.revision < this.value.revision) return;
        this.value = value; this.error = null; this.onChange();
      } catch {
        if (!this.stopped && this.sessionId === id && this.controller === controller) {
          this.error = "Live execution is unavailable. The last observed data may be stale."; this.onChange();
        }
      } finally {
        clearTimeout(timer);
        if (this.controller === controller) { this.controller = null; this.pending = null; }
      }
    })();
    this.pending = pending;
    return pending;
  }

  stop(): void { this.stopped = true; this.controller?.abort(); this.controller = null; this.pending = null; }
}
