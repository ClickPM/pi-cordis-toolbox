import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Context, Service } from "@deepseek-ai/cordis";
import { Type } from "typebox";
import type { OperationContext, OperationResult } from "../../src/core/types.ts";

const execFileAsync = promisify(execFile);

export interface CheckpointRecord {
  id: string;
  label?: string;
  timestamp: number;
  cwd: string;
  snapshotDir: string;
  backedUpFiles: string[];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    checkpoint: CheckpointService;
  }
}

async function copyFilePreserve(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      timeout: 3000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function getGitModifiedFiles(cwd: string): Promise<{ modified: string[]; untracked: string[] }> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-uall"], {
      cwd,
      timeout: 5000,
    });
    const modified: string[] = [];
    const untracked: string[] = [];

    const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const code = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      if (code === "??" || code.includes("?")) {
        untracked.push(filePath);
      } else {
        modified.push(filePath);
      }
    }
    return { modified, untracked };
  } catch {
    return { modified: [], untracked: [] };
  }
}

async function scanWorkspaceFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string, depth = 0) {
    if (depth > 4) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (
        entry.name.startsWith(".git") ||
        entry.name.startsWith(".venv") ||
        entry.name === "node_modules" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(path.relative(cwd, full));
      }
    }
  }
  await walk(cwd);
  return files;
}

export class CheckpointService extends Service {
  static provide = "checkpoint";
  private readonly checkpoints = new Map<string, CheckpointRecord>();
  private readonly tempDirs = new Set<string>();

  constructor(ctx: Context) {
    super(ctx, "checkpoint");
  }

  async create(cwd: string, label?: string): Promise<CheckpointRecord> {
    const id = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const snapshotDir = path.join(os.tmpdir(), "pi-cordis-checkpoints", id);
    await fs.mkdir(snapshotDir, { recursive: true });
    this.tempDirs.add(snapshotDir);

    const backedUpFiles: string[] = [];
    const inGit = await isGitRepo(cwd);

    if (inGit) {
      const { modified, untracked } = await getGitModifiedFiles(cwd);
      const allFiles = [...modified, ...untracked];

      for (const relFile of allFiles) {
        const fullSrc = path.resolve(cwd, relFile);
        try {
          const stat = await fs.stat(fullSrc);
          if (stat.isFile()) {
            const dest = path.join(snapshotDir, "backup", relFile);
            await copyFilePreserve(fullSrc, dest);
            backedUpFiles.push(relFile);
          }
        } catch {
          // File may have been deleted before stat
        }
      }

      try {
        const { stdout: patch } = await execFileAsync("git", ["diff", "HEAD"], {
          cwd,
          timeout: 5000,
        });
        if (patch.trim().length > 0) {
          await fs.writeFile(path.join(snapshotDir, "git-head.patch"), patch, "utf8");
        }
      } catch {
        // Head might not exist in empty repo
      }
    } else {
      // Fallback for non-git workspace directory
      const workspaceFiles = await scanWorkspaceFiles(cwd);
      for (const relFile of workspaceFiles) {
        const fullSrc = path.resolve(cwd, relFile);
        const dest = path.join(snapshotDir, "backup", relFile);
        await copyFilePreserve(fullSrc, dest);
        backedUpFiles.push(relFile);
      }
    }

    const record: CheckpointRecord = {
      id,
      label,
      timestamp: Date.now(),
      cwd,
      snapshotDir,
      backedUpFiles,
    };

    this.checkpoints.set(id, record);
    return record;
  }

  async rollback(id: string): Promise<{ restored: string[]; removed: string[] }> {
    const record = this.checkpoints.get(id);
    if (!record) {
      throw new Error(`Checkpoint "${id}" not found.`);
    }

    const restored: string[] = [];
    const removed: string[] = [];

    const inGit = await isGitRepo(record.cwd);
    if (inGit) {
      const { untracked } = await getGitModifiedFiles(record.cwd);
      for (const relFile of untracked) {
        if (!record.backedUpFiles.includes(relFile)) {
          const target = path.resolve(record.cwd, relFile);
          try {
            await fs.rm(target, { recursive: true, force: true });
            removed.push(relFile);
          } catch {
            // Ignore removal errors
          }
        }
      }
    } else {
      const currentFiles = await scanWorkspaceFiles(record.cwd);
      for (const cur of currentFiles) {
        if (!record.backedUpFiles.includes(cur)) {
          const target = path.resolve(record.cwd, cur);
          try {
            await fs.rm(target, { recursive: true, force: true });
            removed.push(cur);
          } catch {
            // Ignore
          }
        }
      }
    }

    // Restore backed up files from snapshot
    const backupDir = path.join(record.snapshotDir, "backup");
    for (const relFile of record.backedUpFiles) {
      const src = path.join(backupDir, relFile);
      const dest = path.resolve(record.cwd, relFile);
      try {
        await copyFilePreserve(src, dest);
        restored.push(relFile);
      } catch {
        // Continue restoring other files
      }
    }

    return { restored, removed };
  }

  list(): CheckpointRecord[] {
    return [...this.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  async cleanup(): Promise<void> {
    for (const dir of this.tempDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures
      }
    }
    this.tempDirs.clear();
    this.checkpoints.clear();
  }
}

export default function checkpointRewindPlugin(ctx: Context): void {
  const service = new CheckpointService(ctx);

  ctx.effect(() => () => {
    void service.cleanup();
  });

  ctx.toolbox.registerOperation({
    name: "checkpoint.create",
    label: "Create Workspace Checkpoint",
    description: "Snapshot workspace state to allow subsequent rollback if edits fail.",
    risk: "read-only",
    parameters: Type.Object({
      label: Type.Optional(
        Type.String({
          description: "Human-readable label for this checkpoint snapshot.",
        }),
      ),
    }),
    execute: async (params, opCtx: OperationContext): Promise<OperationResult> => {
      const input = params as { label?: string };
      const record = await service.create(opCtx.cwd, input.label);
      return {
        content: `Checkpoint created: [${record.id}] with ${record.backedUpFiles.length} file(s) tracked.`,
        details: record,
      };
    },
  });

  ctx.toolbox.registerOperation({
    name: "checkpoint.rollback",
    label: "Rollback to Checkpoint",
    description: "Restore workspace files to a previously captured checkpoint.",
    risk: "write",
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        description: "Checkpoint ID to restore.",
      }),
    }),
    execute: async (params): Promise<OperationResult> => {
      const input = params as { id: string };
      const res = await service.rollback(input.id);
      return {
        content: `Rollback successful for checkpoint [${input.id}]: restored ${res.restored.length} files, removed ${res.removed.length} newly added files.`,
        details: res,
      };
    },
  });

  ctx.toolbox.registerOperation({
    name: "checkpoint.list",
    label: "List Checkpoints",
    description: "List all active workspace checkpoints in the current session.",
    risk: "read-only",
    parameters: Type.Object({}),
    execute: async (): Promise<OperationResult> => {
      const list = service.list();
      return {
        content: `Active checkpoints: ${list.length}\n` +
          list.map((c) => `- ${c.id} (${new Date(c.timestamp).toISOString()}): ${c.label ?? "no label"}`).join("\n"),
        details: list,
      };
    },
  });
}

checkpointRewindPlugin.inject = ["toolbox"];
checkpointRewindPlugin.provide = "checkpoint";
