import { execFile, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
// Use the installed implementation: Bun aliases the bare undici name to a shim
// that can ignore dispatcher and route loopback through ambient proxy settings.
import { Agent, ProxyAgent, Dispatcher, fetch as undiciFetch, request as undiciRequest } from "undici/index.js";
import { childNetworkEnv, networkRoute, parseSystemProxy, resolveNetworkPolicy, type SystemProxySettings } from "./networkPolicy.js";

async function readSystemProxy(signal: AbortSignal): Promise<SystemProxySettings> {
  if (process.platform !== "darwin") return {};
  return new Promise(resolve => {
    execFile("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 1500, maxBuffer: 128 * 1024, signal }, (error, stdout) => {
      resolve(error || !stdout.includes("<dictionary>") ? { error: "system-proxy-unavailable" } : parseSystemProxy(stdout));
    });
  });
}

export interface NetworkRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  readSystemProxy?: () => Promise<SystemProxySettings>;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  childGraceMs?: number;
}

/** One Relay-owned policy and cancellation scope, independent of UI processes. */
export function createNetworkRuntime(options: NetworkRuntimeOptions = {}) {
  const env = { ...(options.env ?? process.env) };
  const controller = new AbortController();
  const direct = new Agent();
  const proxies = new Map<string, ProxyAgent>();
  const retired = new Set<ProxyAgent>();
  const children = new Map<ChildProcess, Promise<void>>();
  let policy = resolveNetworkPolicy(env);
  let revision = 0;
  let refreshInFlight: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let lastRefreshError: string | undefined;

  function dispatcher(input: string | URL): Dispatcher {
    const route = networkRoute(input, policy);
    if (route.mode === "unsupported") throw Object.assign(new Error(route.reason), { code: route.reason });
    if (route.mode === "direct") return direct;
    let proxy = proxies.get(route.proxyUrl);
    if (!proxy) {
      const address = new URL(route.proxyUrl);
      const socks = address.protocol === "socks5:" || address.protocol === "socks:";
      proxy = new ProxyAgent({
        uri: route.proxyUrl,
        ...(socks ? { username: decodeURIComponent(address.username), password: decodeURIComponent(address.password) } : {}),
      });
      proxies.set(route.proxyUrl, proxy);
    }
    return proxy;
  }

  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (controller.signal.aborted) throw new Error("relay-stopping");
    if (revision === 0) await refresh();
    if (controller.signal.aborted) throw new Error("relay-stopping");
    const signals = [controller.signal, AbortSignal.timeout(options.requestTimeoutMs ?? 15_000)];
    const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal) signals.push(signal);
    // Keep the caller's method, headers, body and redirect semantics; a routing
    // dispatcher reevaluates the destination for redirects, including loopback.
    const routing = new class extends Dispatcher {
      dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
        return dispatcher(String(opts.origin)).dispatch(opts, handler);
      }
    }();
    return (options.fetchImpl ?? globalThis.fetch)(input, { ...init, signal: AbortSignal.any(signals), dispatcher: routing } as RequestInit);
  };

  function refresh(): Promise<void> {
    if (controller.signal.aborted) return Promise.resolve();
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const system = policy.source === "environment" ? {} : await (options.readSystemProxy ?? (() => readSystemProxy(controller.signal)))().catch(() => ({ error: "system-proxy-unavailable" }));
      if (controller.signal.aborted) return;
      lastRefreshError = system.error;
      // Keep the last known system policy on a transient read failure. Initial
      // failure remains explicit; do not silently switch an existing proxy off.
      if (system.error === "system-proxy-unavailable" && revision > 0) return;
      const next = resolveNetworkPolicy(env, system);
      if (JSON.stringify(next) !== JSON.stringify(policy) || revision === 0) {
        policy = next;
        revision += 1;
        // Retire old pools after their in-flight requests finish.
        for (const proxy of proxies.values()) {
          retired.add(proxy);
          void proxy.close().catch(() => undefined).finally(() => retired.delete(proxy));
        }
        proxies.clear();
      }
    })().finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
  }

  function trackChild(child: ChildProcess): () => void {
    let done!: () => void;
    const exited = new Promise<void>(resolve => { done = resolve; });
    const finish = () => { children.delete(child); done(); };
    children.set(child, exited);
    child.once("close", finish);
    child.on("error", () => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) finish(); });
    if (child.exitCode !== null || child.signalCode !== null) finish();
    if (controller.signal.aborted) child.kill("SIGTERM");
    return () => {
      // A settled protocol request may still have a living child: retain it
      // until close so Relay shutdown can always reap it.
      if (child.exitCode !== null || child.signalCode !== null) finish();
    };
  }

  function close(): Promise<void> {
    if (closing) return closing;
    controller.abort();
    closing = (async () => {
      const active = [...children.entries()];
      for (const [child] of active) child.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(active.map(([, exited]) => exited)),
        new Promise<void>(resolve => { timer = setTimeout(resolve, options.childGraceMs ?? 1000); }),
      ]);
      if (timer) clearTimeout(timer);
      for (const [child] of active) if (children.has(child)) child.kill("SIGKILL");
      let reap: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(active.map(([, exited]) => exited)),
        new Promise<void>(resolve => { reap = setTimeout(resolve, 1000); }),
      ]);
      if (reap) clearTimeout(reap);
      await Promise.allSettled([direct.destroy(), ...[...proxies.values(), ...retired].map(proxy => proxy.destroy())]);
      proxies.clear();
      retired.clear();
    })();
    return closing;
  }

  return {
    fetch: fetchImpl,
    refresh,
    childEnv: (network = true) => {
      if (controller.signal.aborted) throw new Error("relay-stopping");
      return network ? childNetworkEnv(env, policy) : { ...env };
    },
    trackChild,
    close,
    status: () => ({ source: policy.source, revision, state: controller.signal.aborted ? "stopped" : revision === 0 ? "uninitialized" : policy.unsupported ? "unsupported" : "ready", issue: policy.unsupported ?? lastRefreshError, child_policy: "inherited-environment-tool-dependent" }),
  };
}

let providerRuntime: ReturnType<typeof createNetworkRuntime> | undefined;
const runtime = () => providerRuntime ??= createNetworkRuntime();
export const providerFetch: typeof fetch = (input, init) => runtime().fetch(input, init);
export const providerChildEnv = (network = true) => runtime().childEnv(network);
export const trackProviderChild = (child: ChildProcess) => runtime().trackChild(child);
export const relayChildEnv = (network = false) => runtime().childEnv(network);
export const trackRelayChild = trackProviderChild;
export const refreshProviderNetwork = () => runtime().refresh();
export const providerNetworkStatus = () => runtime().status();
export const closeProviderNetwork = () => providerRuntime?.close() ?? Promise.resolve();

// UI -> Relay always has a direct dispatcher, even when the process was
// launched with NODE_USE_ENV_PROXY. No total deadline here: SSE stays open.
let localAgent: Agent | undefined;
export const localFetch: typeof fetch = async (input, init) => {
  const dispatcher = localAgent ??= new Agent();
  if (!(process.versions as Record<string, string | undefined>).bun) {
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init, dispatcher,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  }
  // Bun 1.3's fetch compatibility layer also stalls chunked Undici bodies.
  // The request API keeps the actual direct dispatcher and streaming body.
  // Relay API calls do not redirect; retain the response instead of following
  // a location into an external service with local authentication attached.
  const request = new Request(input, init);
  const response = await undiciRequest(request.url, {
    dispatcher, method: request.method as Dispatcher.HttpMethod,
    headers: Object.fromEntries(request.headers), signal: request.signal,
    body: request.body ? Buffer.from(await request.arrayBuffer()) : undefined,
  });
  const headers = new Headers();
  for (const [name, values] of Object.entries(response.headers)) {
    for (const value of Array.isArray(values) ? values : [values]) if (value !== undefined) headers.append(name, value);
  }
  const noBody = request.method === "HEAD" || [204, 205, 304].includes(response.statusCode);
  if (noBody) response.body.resume();
  return new Response(noBody ? null : Readable.toWeb(response.body) as ReadableStream<Uint8Array>, {
    status: response.statusCode, headers,
  });
};
