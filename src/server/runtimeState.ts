import { existsSync, openSync, closeSync, readFileSync, readdirSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionBarRuntimeState {
  pid: number;
  port: number;
  started_at: number;
}

export function configuredPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.SESSIONBAR_PORT || env.SESSION_BAR_PORT || env.PORT;
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

export function runtimePaths(home: string) {
  return {
    lock: join(home, "server.lock"),
    pid: join(home, "server.pid"),
    port: join(home, "port"),
    clients: join(home, "clients"),
  };
}

type PidAlive = (pid: number) => boolean;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pruneAppClients(home: string, alive: PidAlive): number[] {
  const dir = runtimePaths(home).clients;
  if (!existsSync(dir)) return [];
  const live: number[] = [];
  for (const file of readdirSync(dir)) {
    const pid = Number(file);
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) live.push(pid);
    else try { unlinkSync(join(dir, file)); } catch { /* ignore */ }
  }
  return live;
}

export function acquireAppClient(home: string, pid = process.pid, alive: PidAlive = processAlive): number {
  const dir = runtimePaths(home).clients;
  mkdirSync(dir, { recursive: true });
  const live = pruneAppClients(home, alive);
  writeFileSync(join(dir, String(pid)), `${Date.now()}\n`);
  return new Set([...live, pid]).size;
}

export function releaseAppClient(home: string, pid = process.pid, alive: PidAlive = processAlive): boolean {
  const dir = runtimePaths(home).clients;
  try { unlinkSync(join(dir, String(pid))); } catch { /* ignore */ }
  return pruneAppClients(home, alive).length === 0;
}

export function readRuntimeState(home: string): SessionBarRuntimeState | undefined {
  const paths = runtimePaths(home);
  try {
    const pid = Number(readFileSync(paths.pid, "utf8").trim().split("|")[0]);
    const port = Number(readFileSync(paths.port, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
    return { pid, port, started_at: 0 };
  } catch {
    return undefined;
  }
}

export function writeRuntimeState(home: string, state: SessionBarRuntimeState): void {
  const paths = runtimePaths(home);
  writeFileSync(paths.pid, `${state.pid}|node|${state.started_at}`);
  writeFileSync(paths.port, `${state.port}\n`);
}

function livePid(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireInstanceLock(home: string, pid = process.pid): number | undefined {
  const path = runtimePaths(home).lock;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, `${pid}\n`);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || livePid(path)) return undefined;
      try { unlinkSync(path); } catch { return undefined; }
    }
  }
  return undefined;
}

export function releaseRuntimeState(home: string, lockFd?: number): void {
  const paths = runtimePaths(home);
  if (lockFd !== undefined) {
    try { closeSync(lockFd); } catch { /* ignore */ }
  }
  for (const path of [paths.lock, paths.pid, paths.port]) {
    if (existsSync(path)) try { unlinkSync(path); } catch { /* ignore */ }
  }
}
