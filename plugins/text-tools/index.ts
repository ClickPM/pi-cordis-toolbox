import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";

export default function textTools(ctx: Context): void {
  ctx.toolbox.registerOperation({
    name: "text.find",
    label: "Find in text",
    description: "Find literal or regular-expression matches in provided text.",
    risk: "read-only",
    parameters: Type.Object({
      text: Type.String(),
      pattern: Type.String({ minLength: 1 }),
      regex: Type.Optional(Type.Boolean()),
      caseSensitive: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    execute: async (params) => {
      const input = params as {
        text: string;
        pattern: string;
        regex?: boolean;
        caseSensitive?: boolean;
        limit?: number;
      };
      const flags = input.caseSensitive ? "g" : "gi";
      const expression = input.regex
        ? new RegExp(input.pattern, flags)
        : new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      const limit = input.limit ?? 50;
      const matches: Array<{ match: string; index: number }> = [];
      for (const match of input.text.matchAll(expression)) {
        matches.push({ match: match[0], index: match.index ?? 0 });
        if (matches.length >= limit) break;
        if (match[0] === "") expression.lastIndex += 1;
      }
      return {
        content: JSON.stringify(matches, null, 2),
        details: { count: matches.length, truncated: matches.length >= limit },
      };
    },
  });

  ctx.toolbox.registerOperation({
    name: "text.stats",
    label: "Text statistics",
    description: "Count lines, words, Unicode code points, and UTF-8 bytes in provided text.",
    risk: "read-only",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (params) => {
      const text = (params as { text: string }).text;
      const stats = {
        lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
        words: text.trim() ? text.trim().split(/\s+/u).length : 0,
        characters: [...text].length,
        bytes: Buffer.byteLength(text, "utf8"),
      };
      return { content: JSON.stringify(stats, null, 2), details: stats };
    },
  });
}
textTools.inject = ["toolbox"];
