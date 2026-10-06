import { writePrivateState } from "../shared/privateState.js";
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

export function syncToICloud(sessions: SessionPayload[]) {
  try {
    writePrivateState(FILE, JSON.stringify(sessions));
  } catch {
    // iCloud not available — silent skip
  }
}
