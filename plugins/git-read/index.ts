import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    signal,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    timeout: 20_000,
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

function rejectRevision(value: string): void {
  if (!/^[A-Za-z0-9_./~^@{}:+-]{1,200}$/.test(value) || value.startsWith("-")) {
    throw new Error(`Invalid Git revision: ${value}`);
  }
}

export default function gitRead(ctx: Context): void {
  ctx.toolbox.registerOperation({
    name: "git.status",
    label: "Git status",
    description: "Show porcelain Git status for the active workspace repository.",
    risk: "read-only",
    parameters: Type.Object({}),
    execute: async (_params, operationContext) => {
      const content = await git(operationContext.cwd, ["status", "--short", "--branch"], operationContext.signal);
      return { content: content || "Working tree clean.", details: null };
    },
  });

  ctx.toolbox.registerOperation({
    name: "git.diff",
    label: "Git diff",
    description: "Show a bounded read-only Git diff. Optionally inspect staged changes or one relative path.",
    risk: "read-only",
    parameters: Type.Object({
      staged: Type.Optional(Type.Boolean()),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    }),
    execute: async (params, operationContext) => {
      const input = params as { staged?: boolean; path?: string };
      const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3"];
      if (input.staged) args.push("--cached");
      if (input.path) {
        if (input.path.startsWith("-") || input.path.includes("..")) throw new Error("Invalid repository-relative path.");
        args.push("--", input.path);
      }
      const content = await git(operationContext.cwd, args, operationContext.signal);
      return { content: content || "No diff.", details: { staged: input.staged ?? false, path: input.path } };
    },
  });

  ctx.toolbox.registerOperation({
    name: "git.log",
    label: "Git log",
    description: "Show recent one-line Git commits from an optional safe revision.",
    risk: "read-only",
    parameters: Type.Object({
      revision: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: async (params, operationContext) => {
      const input = params as { revision?: string; limit?: number };
      const args = ["log", `-${input.limit ?? 10}`, "--oneline", "--decorate", "--no-color"];
      if (input.revision) {
        rejectRevision(input.revision);
        args.push(input.revision);
      }
      const content = await git(operationContext.cwd, args, operationContext.signal);
      return { content: content || "No commits.", details: { revision: input.revision, limit: input.limit ?? 10 } };
    },
  });
}
gitRead.inject = ["toolbox"];
