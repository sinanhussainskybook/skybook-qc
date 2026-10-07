import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Terminal questions for the command-line tools. */

export class PromptCancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "PromptCancelledError";
  }
}

/** Ask a question; the answer is shown as it is typed. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  // Ctrl+C, or the input ending before an answer (e.g. an empty pipe),
  // cancels instead of leaving the question hanging.
  const cancelled = new Promise<never>((_, reject) => {
    rl.once("SIGINT", () => reject(new PromptCancelledError()));
    rl.once("close", () => reject(new PromptCancelledError()));
  });
  try {
    return await Promise.race([rl.question(question), cancelled]);
  } finally {
    rl.close();
  }
}

/**
 * Ask for a secret. Nothing is echoed, so the password doesn't appear on
 * screen or in the terminal's scroll-back.
 */
export function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) {
    return Promise.reject(new Error("Passwords can only be typed in an interactive terminal."));
  }

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";

    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: string) => {
      // Arrow keys and other escape sequences: ignore the whole sequence.
      if (chunk.startsWith("\u001b")) return;
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new PromptCancelledError()); // Ctrl+C
        if (char === "\u007f" || char === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (char >= " ") {
          value += char;
        }
      }
    };

    stdin.on("data", onData);
  });
}
