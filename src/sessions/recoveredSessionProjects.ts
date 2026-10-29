import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import type { SessionPayload } from "../shared/types.js";

// report.sh hashes the full PROJECT_DIR plus echo's newline. The remaining
// suffix is a native-session hash, a terminal hash, or a nonterminal process ID.
const MARKER = /^sessionbar-id-[a-z0-9_-]+-([a-f0-9]{32})-(?:session-[a-f0-9]{16}|[a-f0-9]{32}|notty-\d+)$/i;

/** Recover only associations proven by a marker's full path hash and an already
 * known local absolute path. Unknown marker formats stay unassigned. */
export function recoverSessionProjects(
  sessions: Record<string, SessionPayload>,
  markers: ReadonlyMap<string, readonly string[]>,
): void {
  const pathsByHash = new Map<string, Set<string>>();
  for (const session of Object.values(sessions)) {
    const path = session.project_path;
    if (session.origin === "remote" || !path || !isAbsolute(path)) continue;
    const hash = createHash("md5").update(`${path}\n`).digest("hex");
    const paths = pathsByHash.get(hash) ?? new Set<string>();
    paths.add(path);
    pathsByHash.set(hash, paths);
  }

  for (const session of Object.values(sessions)) {
    if (session.origin === "remote" || session.project_path) continue;
    const files = markers.get(session.session_id);
    if (!files?.length) continue;
    const hashes = files.map(file => MARKER.exec(file)?.[1]?.toLowerCase());
    if (hashes.some(hash => !hash) || new Set(hashes).size !== 1) continue;
    const paths = pathsByHash.get(hashes[0]!);
    if (paths?.size !== 1) continue;
    const path = [...paths][0]!;
    session.project_path = path;
    session.project ||= basename(path) || path;
  }
}
