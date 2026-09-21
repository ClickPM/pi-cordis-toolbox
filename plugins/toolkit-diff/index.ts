import { promises as fs } from "node:fs";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";
import type { OperationContext, OperationResult } from "../../src/core/types.ts";

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function tryReadFile(cwd: string, input: string): Promise<string | undefined> {
  const resolved = path.resolve(cwd, input);
  if (!isInside(cwd, resolved)) {
    throw new Error(`Path escapes workspace boundary: ${input}`);
  }
  try {
    const stat = await fs.stat(resolved);
    if (stat.isFile()) {
      return await fs.readFile(resolved, "utf8");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface DiffLine {
  type: "added" | "deleted" | "unchanged";
  text: string;
}

// Compute Longest Common Subsequence between lines
function computeLcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "unchanged", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", text: newLines[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      result.push({ type: "deleted", text: oldLines[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

function formatUnified(diffLines: DiffLine[], sourceLabel: string, targetLabel: string): string {
  const header = `--- ${sourceLabel}\n+++ ${targetLabel}\n`;
  if (diffLines.every((l) => l.type === "unchanged")) {
    return `${header}No changes detected.`;
  }

  const out: string[] = [header];
  for (const line of diffLines) {
    if (line.type === "added") {
      out.push(`+ ${line.text}`);
    } else if (line.type === "deleted") {
      out.push(`- ${line.text}`);
    } else {
      out.push(`  ${line.text}`);
    }
  }
  return out.join("\n");
}

function formatSummary(diffLines: DiffLine[], sourceLabel: string, targetLabel: string): string {
  let added = 0;
  let deleted = 0;
  let unchanged = 0;

  for (const line of diffLines) {
    if (line.type === "added") added++;
    else if (line.type === "deleted") deleted++;
    else unchanged++;
  }

  return [
    `Diff Summary: [${sourceLabel}] vs [${targetLabel}]`,
    `  Added lines:     ${added}`,
    `  Deleted lines:   ${deleted}`,
    `  Unchanged lines: ${unchanged}`,
    `  Total changes:   ${added + deleted}`,
  ].join("\n");
}

export default function toolkitDiffPlugin(ctx: Context): void {
  ctx.toolbox.registerOperation({
    name: "tool.diff",
    label: "Compute Structured Diff",
    description:
      "Compute structured line diff or summary between two files or raw texts without calling LLM.",
    risk: "read-only",
    parameters: Type.Object({
      source: Type.String({
        minLength: 1,
        description: "Source file path relative to workspace or raw source string.",
      }),
      target: Type.String({
        minLength: 1,
        description: "Target file path relative to workspace or raw target string.",
      }),
      isPath: Type.Optional(
        Type.Boolean({
          description:
            "Explicitly treat inputs as file paths (true) or strings (false). Auto-detects if omitted.",
        }),
      ),
      format: Type.Optional(
        Type.Union([Type.Literal("unified"), Type.Literal("summary")], {
          description: "Output format: 'unified' (default) or 'summary'.",
        }),
      ),
    }),
    execute: async (params, operationContext: OperationContext): Promise<OperationResult> => {
      const input = params as {
        source: string;
        target: string;
        isPath?: boolean;
        format?: "unified" | "summary";
      };

      let sourceText = input.source;
      let targetText = input.target;
      let sourceLabel = "source";
      let targetLabel = "target";

      const shouldCheckPath = input.isPath !== false;
      if (shouldCheckPath) {
        const maybeSourceFile = await tryReadFile(operationContext.cwd, input.source);
        if (maybeSourceFile !== undefined) {
          sourceText = maybeSourceFile;
          sourceLabel = input.source;
        } else if (input.isPath === true) {
          throw new Error(`Source file not found: ${input.source}`);
        }

        const maybeTargetFile = await tryReadFile(operationContext.cwd, input.target);
        if (maybeTargetFile !== undefined) {
          targetText = maybeTargetFile;
          targetLabel = input.target;
        } else if (input.isPath === true) {
          throw new Error(`Target file not found: ${input.target}`);
        }
      }

      const sourceLines = sourceText.split(/\r?\n/);
      const targetLines = targetText.split(/\r?\n/);
      const diffLines = computeLcsDiff(sourceLines, targetLines);

      const format = input.format ?? "unified";
      const content =
        format === "summary"
          ? formatSummary(diffLines, sourceLabel, targetLabel)
          : formatUnified(diffLines, sourceLabel, targetLabel);

      return {
        content,
        details: {
          format,
          hasChanges: diffLines.some((l) => l.type !== "unchanged"),
        },
      };
    },
  });
}

toolkitDiffPlugin.inject = ["toolbox"];
