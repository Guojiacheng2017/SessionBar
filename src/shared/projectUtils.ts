import { homedir } from "os";

// Minimal interface satisfied by both SessionPayload (openTuiMonitor) and
// the `any`-shaped objects in cli.ts (menu/status).
export interface ProjectSessionLike {
  project?: string | null;
  project_path?: string | null;
  session_id?: string;
  session_type?: string;
}

export function projectName(s: ProjectSessionLike): string {
  if (s.project) return s.project;
  if (s.project_path) return s.project_path.split("/").filter(Boolean).at(-1) || s.project_path;
  const sid = s.session_id || "";
  const sep = sid.indexOf("__");
  if (sep !== -1) return sid.slice(sep + 2);
  return sid || "unknown";
}

export function pathTail(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.at(-1) || path;
}

/** Compact a path: replace home directory with ~. */
export function compactPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function rawProjectPath(s: ProjectSessionLike): string {
  return typeof s.project_path === "string" ? s.project_path.trim() : "";
}

/**
 * For projects that share a name but have different paths, return the
 * unambiguous path mapping (name → compactPath) so grouping can collapse
 * same-name projects when there's only one path.
 */
export function uniqueProjectPathsByName(sessions: readonly ProjectSessionLike[]): Map<string, string> {
  const paths = new Map<string, Set<string>>();
  for (const s of sessions) {
    const path = rawProjectPath(s);
    if (!path) continue;
    const name = s.project || pathTail(path);
    if (!paths.has(name)) paths.set(name, new Set());
    paths.get(name)!.add(compactPath(path));
  }
  const unique = new Map<string, string>();
  for (const [name, values] of paths.entries()) {
    if (values.size === 1) unique.set(name, [...values][0]!);
  }
  return unique;
}

export function projectGroupKey(s: ProjectSessionLike, uniquePaths: Map<string, string>): string {
  const path = rawProjectPath(s);
  if (path) return `path:${compactPath(path)}`;
  const name = projectName(s);
  const inferred = uniquePaths.get(name);
  return inferred ? `path:${inferred}` : `name:${name}`;
}

export function projectPathSummary(sessions: readonly ProjectSessionLike[]): string {
  if (sessions.length === 0) return "unknown";
  const name = projectName(sessions[0]!);
  const unique = [...new Set(sessions.map(rawProjectPath).filter(Boolean).map(compactPath))];
  if (unique.length === 0) return name;
  return unique.length === 1 ? unique[0]! : `${unique[0]} +${unique.length - 1}`;
}

export function groupByProject(sessions: readonly ProjectSessionLike[]): Map<string, ProjectSessionLike[]> {
  const groups = new Map<string, ProjectSessionLike[]>();
  const uniquePaths = uniqueProjectPathsByName(sessions);
  for (const session of sessions) {
    const key = projectGroupKey(session, uniquePaths);
    const list = groups.get(key) || [];
    list.push(session);
    groups.set(key, list);
  }
  return new Map(
    [...groups.entries()].sort((a, b) =>
      projectName(a[1][0]!).localeCompare(projectName(b[1][0]!)) || a[0].localeCompare(b[0])
    )
  );
}
