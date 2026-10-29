import { existsSync, statSync, watch, type FSWatcher, type WatchOptions } from "fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, win32 } from "path";

export type RuntimeLane = "session" | "provider" | "system" | "cost";
export type SourceRead<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface SourceChange {
  kind: "targeted" | "reconcile";
  paths: readonly string[];
}

export interface FileSourceAdapter<T> {
  id: string;
  lane: RuntimeLane;
  roots: readonly string[];
  accepts(path: string): boolean;
  read(change: SourceChange): Promise<SourceRead<T>> | SourceRead<T>;
  apply(value: T, change: SourceChange): boolean;
}

export interface FileSourceRuntimeOptions {
  debounceMs?: number;
  reconcileMs?: number;
  watchFactory?: typeof watch;
  onError?: (sourceId: string, error: unknown) => void;
  onChange?: (sourceId: string) => void;
}

export const DEFAULT_SOURCE_DEBOUNCE_MS = 300;
export const DEFAULT_RECONCILE_MS = 5 * 60_000;

export function watchedPath(root: string, filename: string | Buffer | null, platform: NodeJS.Platform = process.platform): string {
  if (!filename || filename.length === 0) return normalizeForPlatform(root, platform);
  const value = filename.toString();
  if (platform === "win32") {
    return win32.normalize(win32.isAbsolute(value) ? value : win32.join(root, value));
  }
  return normalize(isAbsolute(value) ? value : join(root, value));
}

export function pathInsideRoot(path: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = platform === "win32" ? win32 : { normalize, relative };
  const candidate = platform === "win32" ? pathApi.normalize(path).toLowerCase() : pathApi.normalize(path);
  const base = platform === "win32" ? pathApi.normalize(root).toLowerCase() : pathApi.normalize(root);
  const offset = pathApi.relative(base, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsoluteForPlatform(offset, platform));
}

function normalizeForPlatform(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.normalize(path) : normalize(path);
}

function isAbsoluteForPlatform(path: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
}

export function stableFingerprint(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortValue(child)]));
}

export function laneIntervalMs(lane: RuntimeLane, visible: boolean): number {
  const foreground: Record<RuntimeLane, number> = {
    session: DEFAULT_RECONCILE_MS,
    system: 2_000,
    provider: 5 * 60_000,
    cost: 5 * 60_000,
  };
  const background: Record<RuntimeLane, number> = {
    session: DEFAULT_RECONCILE_MS,
    system: 15_000,
    provider: 15 * 60_000,
    cost: 30 * 60_000,
  };
  return (visible ? foreground : background)[lane];
}

export class FileSourceRuntime {
  readonly #adapters: readonly FileSourceAdapter<unknown>[];
  readonly #options: Required<Pick<FileSourceRuntimeOptions, "debounceMs" | "reconcileMs">> & FileSourceRuntimeOptions;
  readonly #pending = new Map<string, Set<string>>();
  readonly #pendingReconcile = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #runs = new Map<string, Promise<void>>();
  readonly #watchers: FSWatcher[] = [];
  #reconcileTimer: NodeJS.Timeout | undefined;

  constructor(adapters: readonly FileSourceAdapter<unknown>[], options: FileSourceRuntimeOptions = {}) {
    this.#adapters = adapters;
    this.#options = {
      ...options,
      debounceMs: options.debounceMs ?? DEFAULT_SOURCE_DEBOUNCE_MS,
      reconcileMs: options.reconcileMs ?? DEFAULT_RECONCILE_MS,
    };
  }

  start(): void {
    const watched = new Set<string>();
    for (const adapter of this.#adapters) {
      for (const root of adapter.roots) {
        const watchRoot = nearestExistingDirectory(root);
        if (!watchRoot || watched.has(watchRoot)) continue;
        watched.add(watchRoot);
        try {
          const watcher = (this.#options.watchFactory ?? watch)(watchRoot, { recursive: true, persistent: false } as WatchOptions, (_event, filename) => {
            this.notify(watchRoot, filename);
          });
          watcher.on("error", error => this.#options.onError?.("watcher", error));
          this.#watchers.push(watcher);
        } catch (error) {
          this.#options.onError?.("watcher", error);
        }
      }
    }
    this.#reconcileTimer = setInterval(() => void this.reconcile(), this.#options.reconcileMs);
    this.#reconcileTimer.unref();
  }

  notify(root: string, filename: string | Buffer | null): void {
    const changedPath = watchedPath(root, filename);
    for (const adapter of this.#adapters) {
      const unknownPath = !filename || filename.length === 0;
      const relevant = adapter.roots.some(sourceRoot => unknownPath
        ? pathInsideRoot(sourceRoot, root) || pathInsideRoot(root, sourceRoot)
        : pathInsideRoot(changedPath, sourceRoot));
      if (!relevant || (!unknownPath && !adapter.accepts(changedPath))) continue;
      if (unknownPath) this.#pendingReconcile.add(adapter.id);
      const pending = this.#pending.get(adapter.id) ?? new Set<string>();
      if (!unknownPath) pending.add(changedPath);
      this.#pending.set(adapter.id, pending);
      const current = this.#timers.get(adapter.id);
      if (current) clearTimeout(current);
      const timer = setTimeout(() => void this.#flush(adapter), this.#options.debounceMs);
      this.#timers.set(adapter.id, timer);
    }
  }

  async reconcile(): Promise<void> {
    await Promise.all(this.#adapters.map(adapter => this.#run(adapter, { kind: "reconcile", paths: [] })));
  }

  close(): void {
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers.length = 0;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#pending.clear();
    this.#pendingReconcile.clear();
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = undefined;
  }

  async #flush(adapter: FileSourceAdapter<unknown>): Promise<void> {
    this.#timers.delete(adapter.id);
    const paths = [...(this.#pending.get(adapter.id) ?? [])];
    this.#pending.delete(adapter.id);
    const reconcile = this.#pendingReconcile.delete(adapter.id);
    await this.#run(adapter, reconcile ? { kind: "reconcile", paths: [] } : { kind: "targeted", paths });
  }

  async #run(adapter: FileSourceAdapter<unknown>, change: SourceChange): Promise<void> {
    const previous = this.#runs.get(adapter.id) ?? Promise.resolve();
    const current = previous.then(() => this.#readAndApply(adapter, change));
    this.#runs.set(adapter.id, current);
    await current;
    if (this.#runs.get(adapter.id) === current) this.#runs.delete(adapter.id);
  }

  async #readAndApply(adapter: FileSourceAdapter<unknown>, change: SourceChange): Promise<void> {
    let result: SourceRead<unknown>;
    try { result = await adapter.read(change); }
    catch (error) { result = { ok: false, error }; }
    if (!result.ok) { this.#options.onError?.(adapter.id, result.error); return; }
    if (adapter.apply(result.value, change)) this.#options.onChange?.(adapter.id);
  }
}

function nearestExistingDirectory(path: string): string | undefined {
  const requested = resolve(path);
  const candidate = existsSync(requested) ? requested : dirname(requested);
  if (!existsSync(candidate)) return undefined;
  try { return statSync(candidate).isDirectory() ? candidate : dirname(candidate); }
  catch { return undefined; }
}
