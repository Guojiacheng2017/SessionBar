import { execFile as systemExecFile } from "node:child_process";
import { totalmem } from "node:os";
import type { SessionRuntimeSnapshot } from "./types.js";

export interface ProcessRecord {
  pid: number;
  ppid: number;
  cpu_percent: number;
  rss_kib: number;
}

interface ExecFileOptions {
  encoding: "utf8";
}

type ExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string) => void,
) => void;

export interface SampleRegisteredProcessesOptions {
  totalMemoryBytes?: number;
  sampledAt?: number;
  execFile?: ExecFile;
}

const PROCESS_TABLE_ARGS = ["-axo", "pid=,ppid=,%cpu=,rss="];

/** Parse whitespace-delimited `ps` rows into usable process records. */
export function parseProcessTable(text: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || fields[0] === "") continue;

    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const cpuPercent = Number(fields[2]);
    const rssKib = Number(fields[3]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isInteger(ppid) || ppid < 0) continue;
    if (!Number.isFinite(cpuPercent) || cpuPercent < 0) continue;
    if (!Number.isInteger(rssKib) || rssKib < 0) continue;

    records.push({
      pid,
      ppid,
      cpu_percent: cpuPercent,
      rss_kib: rssKib,
    });
  }
  return records;
}

/** Aggregate one process and every reachable descendant exactly once. */
export function sampleProcessTree(
  records: readonly ProcessRecord[],
  rootPid: number,
  totalMemoryBytes: number,
  sampledAt: number,
): SessionRuntimeSnapshot | undefined {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return undefined;

  const byPid = new Map<number, ProcessRecord>();
  const childrenByParent = new Map<number, ProcessRecord[]>();
  for (const record of records) {
    if (!byPid.has(record.pid)) byPid.set(record.pid, record);
    const children = childrenByParent.get(record.ppid) ?? [];
    children.push(record);
    childrenByParent.set(record.ppid, children);
  }
  if (!byPid.has(rootPid)) return undefined;

  const pending = [rootPid];
  const visited = new Set<number>();
  let cpuPercent = 0;
  let memoryBytes = 0;
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || visited.has(pid)) continue;
    const record = byPid.get(pid);
    if (!record) continue;

    visited.add(pid);
    cpuPercent += record.cpu_percent;
    memoryBytes += record.rss_kib * 1024;
    for (const child of childrenByParent.get(pid) ?? []) pending.push(child.pid);
  }

  return {
    cpu_percent: cpuPercent,
    memory_bytes: memoryBytes,
    memory_percent: totalMemoryBytes > 0 && Number.isFinite(totalMemoryBytes)
      ? (memoryBytes / totalMemoryBytes) * 100
      : 0,
    process_count: visited.size,
    sampled_at: sampledAt,
  };
}

/** Read `ps` once, then aggregate the shared table for each registered root. */
export async function sampleRegisteredProcesses(
  roots: Iterable<number>,
  options: SampleRegisteredProcessesOptions = {},
): Promise<Map<number, SessionRuntimeSnapshot>> {
  const rootPids = [...new Set(roots)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (rootPids.length === 0) return new Map();

  const stdout = await readProcessTable(options.execFile ?? defaultExecFile);
  const records = parseProcessTable(stdout);
  const totalMemoryBytes = options.totalMemoryBytes ?? totalmem();
  const sampledAt = options.sampledAt ?? Date.now();
  const samples = new Map<number, SessionRuntimeSnapshot>();
  for (const rootPid of rootPids) {
    const snapshot = sampleProcessTree(records, rootPid, totalMemoryBytes, sampledAt);
    if (snapshot) samples.set(rootPid, snapshot);
  }
  return samples;
}

function defaultExecFile(
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string) => void,
): void {
  systemExecFile(file, args, options, (error, stdout) => {
    callback(error, String(stdout ?? ""));
  });
}

function readProcessTable(execFile: ExecFile): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", PROCESS_TABLE_ARGS, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
