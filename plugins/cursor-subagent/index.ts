import { spawn, type ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";
import type { OperationContext, OperationResult } from "../../src/core/types.ts";

interface CursorRunOptions {
  prompt: string;
  mode: "ask" | "execute";
  workdir?: string;
  model?: string;
  operationContext: OperationContext;
  activeProcesses: Set<ChildProcess>;
}

function resolveCursorWorkdir(baseCwd: string, requested?: string): string {
  if (!requested || requested.trim() === "" || requested === ".") {
    return path.resolve(baseCwd);
  }
  const resolved = path.resolve(baseCwd, requested);
  const relative = path.relative(baseCwd, resolved);
  if (relative.startsWith("..") && !path.isAbsolute(requested)) {
    throw new Error(`Target workdir escapes the workspace: ${requested}`);
  }
  return resolved;
}

function findCursorCommand(): string {
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA;
    if (localApp) {
      const p1 = path.join(localApp, "cursor-agent", "cursor-agent.cmd");
      if (fsSync.existsSync(p1)) return p1;
      const p2 = path.join(localApp, "cursor-agent", "agent.cmd");
      if (fsSync.existsSync(p2)) return p2;
    }
    return "cursor-agent";
  }
  return "cursor-agent";
}

function killProcess(child: ChildProcess): void {
  if (child.pid && !child.killed) {
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
  }
}

async function runCursorTask(options: CursorRunOptions): Promise<OperationResult> {
  const { prompt, mode, workdir, model, operationContext, activeProcesses } = options;
  const targetDir = resolveCursorWorkdir(operationContext.cwd, workdir);
  const cursorCmd = findCursorCommand();

  const args: string[] = ["--trust", "-p", "--output-format", "text"];
  if (mode === "ask") {
    args.push("--mode", "ask");
  } else {
    args.push("--yolo");
  }

  args.push("--workspace", targetDir);

  if (model && model.trim()) {
    args.push("--model", model.trim());
  }

  args.push(prompt);

  const child = spawn(cursorCmd, args, {
    cwd: targetDir,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  activeProcesses.add(child);

  const cleanup = () => {
    activeProcesses.delete(child);
    killProcess(child);
  };

  const onAbort = () => {
    cleanup();
  };

  operationContext.signal.addEventListener("abort", onAbort, { once: true });

  try {
    let stdoutOutput = "";
    let stderrOutput = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutOutput += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrOutput += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", (err) => reject(err));
      child.on("close", (code) => resolve(code));
    });

    if (operationContext.signal.aborted) {
      throw new Error("Cursor execution was aborted.");
    }

    const output = stdoutOutput.trim() || stderrOutput.trim();
    if (exitCode !== 0 && !output) {
      throw new Error(`Cursor agent process exited with code ${exitCode}. Details: ${stderrOutput.trim() || "No output."}`);
    }

    return {
      content: output || `Cursor task completed with exit code ${exitCode}.`,
      details: {
        exitCode,
        mode,
        workdir: path.relative(operationContext.cwd, targetDir) || ".",
        model: model ?? "default",
      },
      isError: exitCode !== 0,
    };
  } finally {
    operationContext.signal.removeEventListener("abort", onAbort);
    cleanup();
  }
}

export default function cursorSubagent(ctx: Context): void {
  const activeProcesses = new Set<ChildProcess>();

  ctx.effect(() => () => {
    for (const child of activeProcesses) {
      killProcess(child);
    }
    activeProcesses.clear();
  }, "cursor-subagent-cleanup");

  ctx.toolbox.registerOperation({
    name: "cursor.ask",
    label: "Consult Cursor Agent (read-only)",
    description:
      "Delegate code analysis, architectural review, or semantic codebase search to an isolated Cursor Agent in read-only mode.",
    risk: "read-only",
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        description: "Query or investigation instructions for the Cursor agent.",
      }),
      workdir: Type.Optional(
        Type.String({
          description: "Target directory relative to the current workspace root. Defaults to '.'",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Optional model override for Cursor (e.g., 'gpt-5', 'sonnet-4-thinking').",
        }),
      ),
    }),
    execute: async (params, operationContext) => {
      const input = params as { prompt: string; workdir?: string; model?: string };
      return runCursorTask({
        prompt: input.prompt,
        mode: "ask",
        workdir: input.workdir,
        model: input.model,
        operationContext,
        activeProcesses,
      });
    },
  });

  ctx.toolbox.registerOperation({
    name: "cursor.execute",
    label: "Execute coding task with Cursor",
    description:
      "Instruct Cursor Agent to edit, write, or refactor code across the workspace.",
    risk: "write",
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        description: "Implementation instructions and code edit requirements for Cursor.",
      }),
      workdir: Type.Optional(
        Type.String({
          description: "Target directory relative to the current workspace root. Defaults to '.'",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Optional model override for Cursor.",
        }),
      ),
    }),
    execute: async (params, operationContext) => {
      const input = params as { prompt: string; workdir?: string; model?: string };
      return runCursorTask({
        prompt: input.prompt,
        mode: "execute",
        workdir: input.workdir,
        model: input.model,
        operationContext,
        activeProcesses,
      });
    },
  });
}

cursorSubagent.inject = ["toolbox"];
