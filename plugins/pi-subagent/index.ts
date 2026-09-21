import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";
import type { OperationContext, OperationResult } from "../../src/core/types.ts";

interface PiRunOptions {
  prompt: string;
  isWrite: boolean;
  workdir?: string;
  model?: string;
  operationContext: OperationContext;
  activeProcesses: Set<ChildProcess>;
}

function resolvePiWorkdir(baseCwd: string, requested?: string): string {
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

async function runPiTask(options: PiRunOptions): Promise<OperationResult> {
  const { prompt, isWrite, workdir, model, operationContext, activeProcesses } = options;
  const targetDir = resolvePiWorkdir(operationContext.cwd, workdir);
  const sessionDir = path.join(
    os.tmpdir(),
    `pi-cordis-sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  await fs.mkdir(sessionDir, { recursive: true });

  const args: string[] = [
    "-ne",
    "-p",
    "--session-dir",
    sessionDir,
    "--mode",
    "text",
  ];

  if (!isWrite) {
    args.push("-xt", "write,edit");
  }

  if (model && model.trim()) {
    args.push("--model", model.trim());
  }

  const safePrompt = process.platform === "win32" ? `"${prompt.replace(/"/g, '\\"')}"` : prompt;
  args.push(safePrompt);

  const child = spawn("pi", args, {
    cwd: targetDir,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  activeProcesses.add(child);

  const cleanup = async () => {
    activeProcesses.delete(child);
    killProcess(child);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  };

  const onAbort = () => {
    void cleanup();
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
      throw new Error("Pi subagent execution was aborted.");
    }

    // Filter out common CLI logger info if needed
    const output = stdoutOutput
      .split(/\r?\n/)
      .filter((line) => !line.includes("server.py:733") && !line.includes("ListToolsRequest"))
      .join("\n")
      .trim();

    if (exitCode !== 0 && !output) {
      throw new Error(`Pi subagent exited with code ${exitCode}. Details: ${stderrOutput.trim() || "No output."}`);
    }

    return {
      content: output || `Pi subagent completed with exit code ${exitCode}.`,
      details: {
        exitCode,
        isWrite,
        workdir: path.relative(operationContext.cwd, targetDir) || ".",
        model: model ?? "default",
      },
      isError: exitCode !== 0,
    };
  } finally {
    operationContext.signal.removeEventListener("abort", onAbort);
    await cleanup();
  }
}

export default function piSubagent(ctx: Context): void {
  const activeProcesses = new Set<ChildProcess>();

  ctx.effect(() => () => {
    for (const child of activeProcesses) {
      killProcess(child);
    }
    activeProcesses.clear();
  }, "pi-subagent-cleanup");

  ctx.toolbox.registerOperation({
    name: "pi.run",
    label: "Delegate task to Pi (read-only)",
    description:
      "Delegate a general reconnaissance, documentation drafting, or research task to an isolated Pi subagent.",
    risk: "read-only",
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        description: "Task instructions for the Pi subagent.",
      }),
      workdir: Type.Optional(
        Type.String({
          description: "Target directory relative to the current workspace root. Defaults to '.'",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Optional model override for Pi.",
        }),
      ),
    }),
    execute: async (params, operationContext) => {
      const input = params as { prompt: string; workdir?: string; model?: string };
      return runPiTask({
        prompt: input.prompt,
        isWrite: false,
        workdir: input.workdir,
        model: input.model,
        operationContext,
        activeProcesses,
      });
    },
  });

  ctx.toolbox.registerOperation({
    name: "pi.execute",
    label: "Execute task with Pi (write)",
    description:
      "Instruct Pi subagent to perform tasks that may edit, create, or modify files in the workspace.",
    risk: "write",
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        description: "Task instructions for the Pi subagent.",
      }),
      workdir: Type.Optional(
        Type.String({
          description: "Target directory relative to the current workspace root. Defaults to '.'",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Optional model override for Pi.",
        }),
      ),
    }),
    execute: async (params, operationContext) => {
      const input = params as { prompt: string; workdir?: string; model?: string };
      return runPiTask({
        prompt: input.prompt,
        isWrite: true,
        workdir: input.workdir,
        model: input.model,
        operationContext,
        activeProcesses,
      });
    },
  });
}

piSubagent.inject = ["toolbox"];
