import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { providerChildEnv, trackProviderChild } from "../runtime/networkRuntime.js";

const execFileAsync = promisify(execFile);

/** Keep short-lived local provider commands under the Relay runtime's ownership. */
export async function execProviderFile(
  executable: string,
  args: readonly string[],
  options: Pick<ExecFileOptions, "maxBuffer" | "timeout"> & { network?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { network = true, ...execOptions } = options;
  const pending = execFileAsync(executable, args, {
    ...execOptions,
    env: providerChildEnv(network),
    encoding: "utf8",
  });
  const untrack = trackProviderChild(pending.child);
  try {
    return await pending;
  } finally {
    untrack();
  }
}
