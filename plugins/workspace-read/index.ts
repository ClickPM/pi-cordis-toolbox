import { promises as fs } from "node:fs";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";

async function resolveWorkspacePath(cwd: string, requested: string): Promise<string> {
  const root = await fs.realpath(cwd);
  const resolved = path.resolve(root, requested || ".");
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${requested}`);
  }
  const real = await fs.realpath(resolved);
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Path resolves outside the workspace: ${requested}`);
  }
  return real;
}

export default function workspaceRead(ctx: Context): void {
  ctx.toolbox.registerOperation({
    name: "workspace.read_file",
    label: "Read workspace file",
    description: "Read a UTF-8 text file inside the active workspace. Paths are relative to cwd.",
    risk: "read-only",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    }),
    execute: async (params, operationContext) => {
      const input = params as { path: string; offset?: number; limit?: number };
      const filePath = await resolveWorkspacePath(operationContext.cwd, input.path);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`Not a file: ${input.path}`);
      if (stat.size > 2 * 1024 * 1024) throw new Error("File is larger than the 2 MiB read limit.");
      const text = await fs.readFile(filePath, "utf8");
      const lines = text.split(/\r?\n/);
      const offset = input.offset ?? 1;
      const limit = input.limit ?? 400;
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      return {
        content: selected.join("\n"),
        details: {
          path: path.relative(operationContext.cwd, filePath),
          offset,
          returnedLines: selected.length,
          totalLines: lines.length,
          truncated: offset - 1 + selected.length < lines.length,
        },
      };
    },
  });

  ctx.toolbox.registerOperation({
    name: "workspace.list_directory",
    label: "List workspace directory",
    description: "List direct children of a directory inside the active workspace.",
    risk: "read-only",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    execute: async (params, operationContext) => {
      const input = params as { path?: string; limit?: number };
      const directory = await resolveWorkspacePath(operationContext.cwd, input.path || ".");
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const limit = input.limit ?? 200;
      const rows = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        }));
      return {
        content: JSON.stringify(rows, null, 2),
        details: {
          path: path.relative(operationContext.cwd, directory) || ".",
          totalEntries: entries.length,
          returnedEntries: rows.length,
          truncated: rows.length < entries.length,
        },
      };
    },
  });
}
workspaceRead.inject = ["toolbox"];
