import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";
import type { OperationContext, OperationResult } from "../../src/core/types.ts";

interface CodexRunOptions {
  prompt: string;
  sandbox: "read-only" | "workspace-write";
  workdir?: string;
  model?: string;
  operationContext: OperationContext;
  activeProcesses: Set<ChildProcess>;
}

function resolveCodexWorkdir(baseCwd: string, requested?: string): string {
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

async function runCodexTask(options: CodexRunOptions): Promise<OperationResult> {
  const { prompt, sandbox, workdir, model, operationContext, activeProcesses } = options;
  const targetDir = resolveCodexWorkdir(operationContext.cwd, workdir);
  const tmpOut = path.join(
    os.tmpdir(),
    `codex-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );

  const args: string[] = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    sandbox,
    "-C",
    targetDir,
    "-o",
    tmpOut,
  ];

  if (model && model.trim()) {
    args.push("-m", model.trim());
  }

  // Read prompt from stdin to avoid CLI argument length and escaping limits
  args.push("-");

  const child = spawn("codex", args, {
    cwd: targetDir,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  activeProcesses.add(child);

  const cleanup = async () => {
    activeProcesses.delete(child);
    killProcess(child);
    try {
      await fs.unlink(tmpOut);
    } catch {
      // Ignored if file does not exist
    }
  };

  const onAbort = () => {
    void cleanup();
  };

  operationContext.signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (!child.stdin) {
      throw new Error("Failed to open stdin for Codex child process.");
    }

    child.stdin.write(prompt);
    child.stdin.end();

    let stderrOutput = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrOutput += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", (err) => reject(err));
      child.on("close", (code) => resolve(code));
    });

    if (operationContext.signal.aborted) {
      throw new Error("Codex execution was aborted.");
    }

    let resultText = "";
    try {
      resultText = await fs.readFile(tmpOut, "utf8");
    } catch {
      // If output file wasn't written, fall back to stderr or error message
    }

    if (exitCode !== 0 && !resultText.trim()) {
      throw new Error(`Codex process exited with code ${exitCode}. Details: ${stderrOutput.trim() || "No output."}`);
    }

    return {
      content: resultText.trim() || stderrOutput.trim() || `Codex task completed with exit code ${exitCode}.`,
      details: {
        exitCode,
        sandbox,
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

export default function codexSubagent(ctx: Context): void {
  const activeProcesses = new Set<ChildProcess>();

  // Ensure all active Codex processes are cleanly terminated when Cordis context is disposed
  ctx.effect(() => () => {
    for (const child of activeProcesses) {
      killProcess(child);
    }
    activeProcesses.clear();
  }, "codex-subagent-cleanup");

  ctx.toolbox.registerOperation({
    name: "codex.ask",
    label: "Consult Codex (read-only)",
    description:
      "Delegate a code analysis, architectural review, or codebase query to an isolated local Codex subagent in a read-only sandbox.",
    risk: "read-only",
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        description: "Clear instructions or query for the Codex subagent.",
      }),
      workdir: Type.Optional(
        Type.String({
          description: "Target directory relative to the current workspace root. Defaults to '.'",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Optional model name to use with Codex (e.g. 'o3-mini', 'deepseek-flash').",
        }),
      ),
    }),
    execute: async (params, operationContext) => {
      const input = params as { prompt: string; workdir?: string; model?: string };
      return runCodexTask({
        prompt: input.prompt,
        sandbox: "read-only",
        workdir: input.workdir,
        model: input.model,
        operationContext,
        activeProcesses,
      });
    },
  });

  ctx.toolbox.registerOperation({
    name: "codex.execute",
    label: "Execute coding task with Codex",
    description:
      "Instruct Codex to write, edit, or refactor code in the workspace under workspace-write sandbox.",
    risk: "write",
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        description: "Implementation instructions and task requirements for Codex.",
      }),
      workdir: Type.Optional(
        Type.String({
          description: "Target directory relative to the current workspace root. Defaults to '.'",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Optional model name to use with Codex.",
        }),
      ),
    }),
    execute: async (params, operationContext) => {
      const input = params as { prompt: string; workdir?: string; model?: string };
      return runCodexTask({
        prompt: input.prompt,
        sandbox: "workspace-write",
        workdir: input.workdir,
        model: input.model,
        operationContext,
        activeProcesses,
      });
    },
  });
}

codexSubagent.inject = ["toolbox"];
