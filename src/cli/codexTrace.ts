import type { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolve } from "node:path";
import { CodexStreamRecorder } from "../agents/codexStream.js";

export function isCodexTraceInvocation(args: readonly string[]): boolean {
  if (args[0] === "exec") return args.includes("--json");
  if (args[0] !== "app-server" || ["daemon", "generate-ts", "generate-json-schema"].includes(args[1] ?? "")) return false;
  const index = args.indexOf("--listen"), inline = args.find(arg => arg.startsWith("--listen="));
  return index >= 0 ? args[index + 1] === "stdio://" : !inline || inline === "--listen=stdio://";
}

/** Preserve native arguments, permissions, I/O and exit status; tee metadata only. */
export async function traceCodex(options: { binary: string; args: string[]; cwd: string; eventsRoot: string; env?: NodeJS.ProcessEnv; stdout?: Writable; stderr?: Writable }): Promise<number> {
  let cwd = options.cwd;
  for (let i = 0; i < options.args.length; i++) {
    const arg = options.args[i]!;
    if ((arg === "-C" || arg === "--cd") && options.args[i + 1]) cwd = resolve(options.cwd, options.args[++i]!);
    else if (arg.startsWith("--cd=")) cwd = resolve(options.cwd, arg.slice(5));
  }
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  let recorder: CodexStreamRecorder | undefined;
  try { recorder = new CodexStreamRecorder({ root: options.eventsRoot, cwd }); }
  catch { stderr.write("SessionBar: native event capture unavailable; native command continues.\n"); }
  const child = spawn(options.binary, options.args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["inherit", "pipe", "pipe"] });
  child.stdout.pipe(stdout, { end: false }); child.stderr.pipe(stderr, { end: false });
  let buffer = "", dropping = false, captureFailed = !recorder; const decoder = new StringDecoder("utf8");
  const stopCapture = () => { try { recorder?.close(); } catch { /* A closed/failed capture is not a native task result. */ } };
  const interrupt = () => { stopCapture(); child.kill("SIGINT"); };
  const terminate = () => { stopCapture(); child.kill("SIGTERM"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  child.stdout.on("data", (chunk: Buffer) => {
    const parts = decoder.write(chunk).split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (buffer.length + part.length > 1024 * 1024) {
        buffer = ""; dropping = true;
        if (!captureFailed) { captureFailed = true; stopCapture(); stderr.write("SessionBar: native event capture reached its line limit; native command continues.\n"); }
      }
      if (!dropping) buffer += part;
      if (i === parts.length - 1) break;
      if (!dropping && !captureFailed) {
        let message: unknown; try { message = JSON.parse(buffer); } catch { message = null; }
        try { if (message) recorder?.write(message); } catch { captureFailed = true; stopCapture(); stderr.write("SessionBar: native event capture failed; native command continues.\n"); }
      }
      buffer = ""; dropping = false;
    }
  });
  return new Promise(resolve => {
    let finished = false;
    const finish = (code: number) => { if (finished) return; finished = true; process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); stopCapture(); resolve(code); };
    child.on("error", error => { stderr.write(`SessionBar: ${error.message}\n`); finish(127); });
    child.on("close", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : 143)));
  });
}
