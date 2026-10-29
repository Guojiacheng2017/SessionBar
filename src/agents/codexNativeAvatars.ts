import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexAvatarSource {
  forAgent(nativeId: string): Promise<{ kind: "asset"; asset_id: string } | null>;
  getAsset(assetId: string, theme: "light" | "dark"): Promise<string | null>;
}

type Json = Record<string, unknown>;
type Artwork = { light: string; dark: string };
interface Catalog { order: string[]; assets: Map<string, Artwork> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = "[A-Za-z_$][\\w$]*";
const MAX_HEADER = 8 * 1024 * 1024;
const MAX_SCRIPT = 16 * 1024 * 1024;
const MAX_SVG = 64 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const object = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const own = (value: Json, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined;
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function fail(): never { throw new Error("unsupported native avatar resources"); }

/** Reads only bounded, packed members. Neither paths nor source code are executed. */
class Archive {
  private readBytes = 0;
  private constructor(private file: FileHandle, private base: number, private size: number, readonly assets: Json) {}

  static async read(file: FileHandle, size: number): Promise<Archive> {
    const prefix = await readExact(file, 0, 16);
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > MAX_HEADER
      || prefix.readUInt32LE(8) !== headerSize - 4 || jsonSize < 2 || jsonSize > headerSize - 8
      || headerSize - 8 - jsonSize > 3 || 8 + headerSize > size) fail();
    const root = object(JSON.parse((await readExact(file, 16, jsonSize)).toString("utf8")));
    let files = root && object(own(root, "files"));
    for (const part of ["webview", "assets"]) {
      const directory = files && object(own(files, part));
      if (!directory || directory.link !== undefined || directory.unpacked !== undefined) fail();
      files = object(own(directory, "files"));
    }
    if (!files || Object.keys(files).length > 40_000) fail();
    return new Archive(file, 8 + headerSize, size, files);
  }

  async member(name: string, limit: number): Promise<string> {
    if (!/^[A-Za-z0-9_@.-]+$/.test(name) || name === "." || name === "..") fail();
    const member = object(own(this.assets, name));
    if (!member || member.link !== undefined || member.unpacked !== undefined || member.files !== undefined
      || typeof member.offset !== "string" || !/^(0|[1-9]\d*)$/.test(member.offset)
      || typeof member.size !== "number" || !Number.isSafeInteger(member.size) || member.size <= 0 || member.size > limit) fail();
    const start = this.base + Number(member.offset), size = member.size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(start + size) || start + size > this.size
      || (this.readBytes += size) > MAX_TOTAL) fail();
    return (await readExact(this.file, start, size)).toString("utf8");
  }

  named(pattern: RegExp): string {
    const matches = Object.keys(this.assets).filter(name => pattern.test(name));
    if (matches.length !== 1) fail();
    return matches[0]!;
  }
}

async function readExact(file: FileHandle, position: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const result = await file.read(buffer, read, size - read, position + read);
    if (!result.bytesRead) fail();
    read += result.bytesRead;
  }
  return buffer;
}

const TAGS = new Set(["svg", "g", "path", "rect", "circle", "defs", "clipPath", "mask", "linearGradient", "stop", "filter", "feBlend", "feColorMatrix", "feComposite", "feFlood", "feGaussianBlur", "feOffset"]);
const ATTRIBUTES = new Set(["xmlns", "width", "height", "viewBox", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width", "stroke-linejoin", "clip-path", "clip-rule", "mask", "maskUnits", "filter", "filterUnits", "color-interpolation-filters", "id", "opacity", "d", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "gradientUnits", "offset", "stop-color", "transform", "style", "in", "in2", "result", "mode", "type", "values", "operator", "k2", "k3", "flood-opacity", "dx", "dy", "stdDeviation"]);

/** The known artwork needs shapes, gradients and filters only, never active SVG. */
function validateSvg(svg: string): string {
  if (Buffer.byteLength(svg) > MAX_SVG || /[&\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)) fail();
  const stack: string[] = [];
  let offset = 0, root = false;
  for (const match of svg.matchAll(/<(\/?)([A-Za-z]+)([^<>]*?)(\/?)>/g)) {
    if (svg.slice(offset, match.index).trim()) fail();
    offset = match.index + match[0].length;
    const [, closing, tag, raw, selfClosing] = match;
    if (!TAGS.has(tag!)) fail();
    if (closing) {
      if (raw!.trim() || selfClosing || stack.pop() !== tag) fail();
      continue;
    }
    if (stack.length === 0) {
      if (root || tag !== "svg") fail();
      root = true;
    }
    let attributes = raw!;
    const names = new Set<string>();
    while (attributes.trim()) {
      const attribute = /^\s+([A-Za-z][A-Za-z0-9:-]*)=(?:"([^"]*)"|'([^']*)')/.exec(attributes);
      if (!attribute) fail();
      const name = attribute[1]!, value = attribute[2] ?? attribute[3]!;
      if (!ATTRIBUTES.has(name) || names.has(name) || /[<>`\\]/.test(value)) fail();
      if (name === "xmlns" && value !== "http://www.w3.org/2000/svg") fail();
      if (name === "style" && !/^mix-blend-mode:(multiply|darken)$/.test(value)) fail();
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(value)) fail();
      names.add(name);
      attributes = attributes.slice(attribute[0].length);
    }
    if (tag === "svg" && (!names.has("xmlns") || stack.length > 0)) fail();
    if (!selfClosing) stack.push(tag!);
    if (stack.length > 32) fail();
  }
  if (!root || stack.length || svg.slice(offset).trim()) fail();
  return svg;
}

/** Match the inspected component + selector as a single supported format.
 * Symbol/file hashes may change; unknown algorithms or palettes are rejected. */
function selection(source: string): { component: string; pairs: { light: string; dark: string }[] } {
  const componentPattern = new RegExp("function (" + ID + ")\\(e\\)\\{[^]{0,700}?\\{seed:i,className:n,palette:a,\\.\\.\\.r\\}=e[^]{0,300}?let o=a===void 0\\?`codex`:a,s=" + ID + "\\(\\)===!0,c=o===`chatgpt`\\?10:(" + ID + ")\\.length,l=\\2\\[(" + ID + ")\\(i,c\\)\\],u=s\\?l\\.dark:l\\.light", "g");
  const components = [...source.matchAll(componentPattern)];
  if (components.length !== 1) fail();
  const component = components[0]![1]!, palette = components[0]![2]!, hash = components[0]![3]!;
  const selector = new RegExp("function " + escape(hash) + "\\(e,t\\)\\{let n=0;for\\(let t=0;t<e\\.length;t\\+=1\\)n=\\(n\\*31\\+e\\.charCodeAt\\(t\\)\\)%(" + ID + ");return n%t\\}").exec(source);
  if (!selector) fail();
  const table = new RegExp("(?<![\\w$])" + escape(palette) + "=\\[([^\\]]+)\\]," + escape(selector[1]!) + "=2147483647").exec(source);
  if (!table) fail();
  const pairs = [...table[1]!.matchAll(new RegExp("\\{dark:(" + ID + "),light:(" + ID + ")\\}", "g"))].map(match => ({ dark: match[1]!, light: match[2]! }));
  if (pairs.length !== 28 || pairs.map(pair => `{dark:${pair.dark},light:${pair.light}}`).join(",") !== table[1]) fail();
  return { component, pairs };
}

async function readCatalog(path: string): Promise<Catalog> {
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) fail();
    const archive = await Archive.read(file, before.size);
    const moduleName = archive.named(/^app-initial-[a-z0-9]+\.js$/);
    const source = await archive.member(moduleName, MAX_SCRIPT);
    const { component, pairs } = selection(source);
    // Verify the sub-agent row consumes this component with its avatar seed,
    // and the local panel supplies the real conversation ID without a palette override.
    const exported = new RegExp("(?<![\\w$])" + escape(component) + " as (" + ID + ")[,}]").exec(source);
    if (!exported) fail();
    const panelName = archive.named(/^subagent-panel-[a-z0-9]+\.js$/);
    const panel = await archive.member(panelName, 128 * 1024);
    const imported = new RegExp("import\\{([^}]+)\\}from[\"`]\\./" + escape(moduleName) + "[\"`]").exec(panel);
    const localComponent = imported && new RegExp("(?:^|,)" + escape(exported[1]!) + " as (" + ID + ")(?:,|$)").exec(imported[1]!);
    if (!localComponent || !new RegExp("\\.jsx\\)\\(" + escape(localComponent[1]!) + ",\\{[^}]{0,250}seed:" + ID + "\\.avatarSeed").test(panel)) fail();
    const localPanel = await archive.member(archive.named(/^local-conversation-subagents-panel-tab-[a-z0-9]+\.js$/), 128 * 1024);
    if (!localPanel.includes(`./${panelName}`) || !/avatarSeed:([\w$]+)\.conversationId/.test(localPanel) || localPanel.includes("avatarPalette:")) fail();
    const artwork = new Map<string, string>();
    const resource = async (symbol: string): Promise<string> => {
      if (artwork.has(symbol)) return artwork.get(symbol)!;
      const assignment = new RegExp("(?<![\\w$])" + escape(symbol) + "=`(data:image/svg\\+xml,[^`]+)`").exec(source);
      let svg: string;
      if (assignment) svg = decodeURIComponent(assignment[1]!.slice("data:image/svg+xml,".length));
      else {
        const filename = new RegExp("(?<![\\w$])" + escape(symbol) + "=``\\+new URL\\(`([^`]+)`,import\\.meta\\.url\\)\\.href").exec(source)?.[1];
        if (!filename || !/^[A-Za-z0-9_-]+\.svg$/.test(filename)) fail();
        svg = await archive.member(filename, MAX_SVG);
      }
      artwork.set(symbol, validateSvg(svg));
      return svg;
    };
    const catalog: Catalog = { order: [], assets: new Map() };
    for (const pair of pairs) {
      const light = await resource(pair.light), dark = await resource(pair.dark);
      const id = `codex-native-${createHash("sha256").update(JSON.stringify([light, dark])).digest("hex")}`;
      catalog.order.push(id);
      catalog.assets.set(id, { light, dark });
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail();
    return catalog;
  } finally { await file.close(); }
}

/** Native artwork stays in the installed app; only resolved SVGs are cached in memory.
 * A changed/unsupported app layout fails to null, letting the UI use its code fallback.
 * The catalog is fixed for this source's lifetime; restart the receiver after app updates. */
export function createCodexAvatarSource(options: { archives?: readonly string[] } = {}): CodexAvatarSource {
  const archives = options.archives ?? (process.platform === "darwin"
    ? ["/Applications", join(homedir(), "Applications")].flatMap(root => ["Codex.app", "ChatGPT.app"].map(app => join(root, app, "Contents/Resources/app.asar"))) : []);
  let pending: Promise<Catalog | null> | undefined;
  const load = (): Promise<Catalog | null> => pending ??= (async () => {
    let selected: Catalog | null = null;
    for (const path of archives.slice(0, 4)) {
      let candidate: Catalog;
      try { candidate = await readCatalog(path); } catch { continue; }
      // Different installed versions may assign different artwork to the same
      // UUID. Without knowing its originating app, do not guess which is native.
      if (selected && (selected.order.length !== candidate.order.length
        || selected.order.some((id, index) => id !== candidate.order[index]))) return null;
      selected ??= candidate;
    }
    return selected;
  })();
  return {
    async forAgent(nativeId) {
      if (!UUID.test(nativeId)) return null;
      const catalog = await load();
      if (!catalog) return null;
      let hash = 0;
      for (const code of nativeId.toLowerCase()) hash = (hash * 31 + code.charCodeAt(0)) % 2147483647;
      return { kind: "asset", asset_id: catalog.order[hash % catalog.order.length]! };
    },
    async getAsset(assetId, theme) {
      if (!/^codex-native-[a-f0-9]{64}$/.test(assetId) || (theme !== "light" && theme !== "dark")) return null;
      return (await load())?.assets.get(assetId)?.[theme] ?? null;
    },
  };
}
