import { createInterface, emitKeypressEvents } from "node:readline";

export type SetupFocus = "local" | "global" | "cancel";

export function setupFocusFromKey(value: string): SetupFocus | undefined {
  const key = value.toLowerCase();
  if (key === "l") return "local";
  if (key === "g") return "global";
  if (value === "\x1b" || value === "\u0003") return "cancel";
  return undefined;
}

export async function promptSetupFocus(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<SetupFocus> {
  const prompt = "[l] Local focus  |  [g] Global focus  |  [Esc] Cancel\n> ";
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = createInterface({ input, output });
    return new Promise(resolve => rl.question(prompt, answer => {
      rl.close();
      resolve(setupFocusFromKey(answer.trim().slice(0, 1)) ?? "cancel");
    }));
  }

  output.write(prompt);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();

  return new Promise(resolve => {
    const finish = (focus: SetupFocus) => {
      input.off("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      if (!wasRaw) input.pause();
      output.write(focus === "cancel" ? "Cancel\n" : `${focus === "local" ? "Local" : "Global"}\n`);
      resolve(focus);
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish("cancel");
      const focus = setupFocusFromKey(text);
      if (focus) finish(focus);
    };
    input.on("keypress", onKeypress);
  });
}
