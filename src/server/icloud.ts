import { writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SessionPayload } from "../shared/types.js";

const DIR = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "SessionBar",
);

const FILE = join(DIR, "status.json");
const TMP_FILE = join(DIR, "status.json.tmp");

export function syncToICloud(sessions: SessionPayload[]) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(TMP_FILE, JSON.stringify(sessions));
    renameSync(TMP_FILE, FILE);
  } catch {
    // iCloud not available — silent skip
  }
}
