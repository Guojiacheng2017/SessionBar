import { BlockList, isIP } from "node:net";

export interface SystemProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  bypass?: string[];
  excludeSimpleHostnames?: boolean;
  autoConfig?: boolean;
  error?: string;
}

export interface NetworkPolicy {
  source: "environment" | "system" | "direct";
  httpProxy?: string;
  httpsProxy?: string;
  bypass: string[];
  excludeSimpleHostnames: boolean;
  unsupported?: string;
}

export type NetworkRoute = { mode: "direct" } | { mode: "proxy"; proxyUrl: string } | { mode: "unsupported"; reason: string };
const PROXY_KEYS = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
const value = (env: NodeJS.ProcessEnv, key: string) => env[key.toLowerCase()] ?? env[key];

/** Environment overrides form one explicit configuration; do not mix in system proxies. */
export function resolveNetworkPolicy(env: NodeJS.ProcessEnv, system: SystemProxySettings = {}): NetworkPolicy {
  const explicit = PROXY_KEYS.some(key => env[key] !== undefined);
  const noProxy = value(env, "NO_PROXY");
  if (explicit) {
    const all = value(env, "ALL_PROXY");
    const http = value(env, "HTTP_PROXY") ?? all;
    return {
      source: "environment", httpProxy: http,
      httpsProxy: value(env, "HTTPS_PROXY") ?? all ?? http,
      bypass: (noProxy ?? "").split(/[,\s]+/).filter(Boolean), excludeSimpleHostnames: false,
    };
  }
  return {
    source: system.httpProxy || system.httpsProxy || system.socksProxy || system.autoConfig || system.error ? "system" : "direct",
    httpProxy: system.httpProxy ?? system.socksProxy,
    httpsProxy: system.httpsProxy ?? system.socksProxy,
    bypass: [...(system.bypass ?? []), ...(noProxy ?? "").split(/[,\s]+/).filter(Boolean)],
    excludeSimpleHostnames: system.excludeSimpleHostnames === true,
    unsupported: system.error ?? (system.autoConfig ? "system-pac-unsupported" : undefined),
  };
}

function hostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase(); }

export function isLoopbackUrl(url: URL): boolean {
  const host = hostname(url);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const block = new BlockList();
  block.addSubnet("127.0.0.0", 8, "ipv4");
  return isIP(host) !== 0 && block.check(host, isIP(host) === 6 ? "ipv6" : "ipv4");
}

function bypasses(url: URL, pattern: string): boolean {
  const host = hostname(url);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (pattern.includes("/")) {
    const [address, prefix] = pattern.split("/");
    const version = isIP(address);
    if (!version || !isIP(host) || !/^\d+$/.test(prefix ?? "")) return false;
    try {
      const block = new BlockList();
      block.addSubnet(address, Number(prefix), version === 6 ? "ipv6" : "ipv4");
      return block.check(host, isIP(host) === 6 ? "ipv6" : "ipv4");
    } catch { return false; }
  }
  let target = pattern.toLowerCase();
  const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
  if (withPort) {
    if (withPort[2] !== port) return false;
    target = withPort[1];
  }
  target = target.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (target.startsWith(".")) return host === target.slice(1) || host.endsWith(target);
  const escaped = target.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(host);
}

export function networkRoute(input: string | URL, policy: NetworkPolicy): NetworkRoute {
  const url = new URL(input);
  if (isLoopbackUrl(url)) return { mode: "direct" };
  const host = hostname(url);
  if ((policy.excludeSimpleHostnames && !host.includes(".") && !host.includes(":")) || policy.bypass.some(pattern => bypasses(url, pattern))) return { mode: "direct" };
  if (policy.unsupported) return { mode: "unsupported", reason: policy.unsupported };
  const proxy = url.protocol === "https:" ? policy.httpsProxy : policy.httpProxy;
  if (!proxy) return { mode: "direct" };
  try {
    const parsed = new URL(proxy);
    const socksRemote = parsed.protocol === "socks5h:";
    if (socksRemote) parsed.protocol = "socks5:";
    if (!["http:", "https:", "socks5:", "socks:"].includes(parsed.protocol)) throw new Error();
    // Keep existing spelling unless the scheme needs normalization.
    return { mode: "proxy", proxyUrl: socksRemote ? parsed.href : proxy };
  } catch { return { mode: "unsupported", reason: "invalid-proxy-configuration" }; }
}

/** Read only global scutil keys, never accidentally use one interface's scoped proxy. */
export function parseSystemProxy(text: string): SystemProxySettings {
  const fields: Record<string, string> = {};
  const bypass: string[] = [];
  let depth = 0;
  let exceptions = false;
  let scopedProxy = false;
  for (const line of text.split("\n")) {
    const field = /^\s*([^:]+?)\s+:\s+(.*)$/.exec(line);
    if (depth > 1 && field && /^(HTTP|HTTPS|SOCKS|ProxyAutoConfig|ProxyAutoDiscovery)Enable$/.test(field[1]) && field[2].trim() === "1") scopedProxy = true;
    if (depth === 1 && field) {
      if (field[1] === "ExceptionsList") exceptions = true;
      else fields[field[1]] = field[2].trim();
    } else if (depth === 2 && exceptions && field) bypass.push(field[2].trim());
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (depth < 2) exceptions = false;
  }
  const proxy = (prefix: string, scheme = "http") => {
    if (fields[`${prefix}Enable`] !== "1") return undefined;
    const host = fields[`${prefix}Proxy`];
    const port = Number(fields[`${prefix}Port`]);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return "invalid:";
    return `${scheme}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
  };
  return {
    httpProxy: proxy("HTTP"), httpsProxy: proxy("HTTPS"), socksProxy: proxy("SOCKS", "socks5"), bypass,
    excludeSimpleHostnames: fields.ExcludeSimpleHostnames === "1",
    autoConfig: fields.ProxyAutoConfigEnable === "1" || fields.ProxyAutoDiscoveryEnable === "1",
    error: scopedProxy && !["HTTP", "HTTPS", "SOCKS", "ProxyAutoConfig", "ProxyAutoDiscovery"].some(key => fields[`${key}Enable`] === "1") ? "system-scoped-proxy-unsupported" : undefined,
  };
}

/** External tools retain their own proxy/bypass capabilities; this is environment projection only. */
export function childNetworkEnv(env: NodeJS.ProcessEnv, policy: NetworkPolicy): NodeJS.ProcessEnv {
  if (policy.unsupported) throw new Error(policy.unsupported);
  if (policy.source !== "system") return { ...env };
  const child = { ...env };
  for (const [key, proxy] of [["HTTP_PROXY", policy.httpProxy], ["HTTPS_PROXY", policy.httpsProxy]] as const) {
    if (proxy) { child[key] = proxy; child[key.toLowerCase()] = proxy; }
  }
  child.NO_PROXY = child.no_proxy = [...policy.bypass, "localhost", "127.0.0.1", "::1"].join(",");
  return child;
}
