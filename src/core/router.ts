import path from "node:path";
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import type { JevRoutingInfo } from "./types.ts";

export function fallbackJudge(goal: string): JevRoutingInfo {
  const lower = goal.toLowerCase();
  const requiresWrite = /write|create|modify|edit|implement|fix|refactor|add|delete|remove|update|写|改|加|修复|创建|实现/.test(
    lower,
  );
  let targetAgent: "codex" | "pi" = "codex";

  if (/doc|summary|summarize|explain|readme|research|文档|总结|总结一下|调研/.test(lower)) {
    targetAgent = "pi";
  } else {
    targetAgent = "codex";
  }

  return {
    targetAgent,
    requiresWrite,
    confidence: 0.7,
    probabilities: { [targetAgent]: 0.7 },
    complexity: 1,
    model: "heuristic-fallback",
  };
}

export async function judgeTaskWithJev(goal: string, cwd: string): Promise<JevRoutingInfo> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    return fallbackJudge(goal);
  }

  try {
    const client = new TypeSafeClient({ apiKey });
    const response = await client.systemOne({
      state: {
        task: goal,
        cwd_name: path.basename(cwd),
      },
      questions: {
        target_agent: choice(
          "Which specialized autonomous agent is best suited to handle this task?",
          {
            codex: "Code generation, code analysis, bug fixing, test writing, refactoring, implementation",
            pi: "General reconnaissance, research, documentation drafting, bash/terminal automation, high-level summaries",
          },
        ),
        requires_write: noul(
          "Does this task require writing, editing, modifying, or creating files in the workspace?",
        ),
        complexity: score("How complex is this task?", [
          "Simple lookup or single question",
          "Moderate targeted task",
          "Complex multi-file or deep investigation",
        ]),
      },
    });

    const agentChoice = response.answers.target_agent.choice as "codex" | "pi";
    const requiresWrite = (response.answers.requires_write.noul ?? 0) >= 0.5;

    return {
      targetAgent: agentChoice ?? "codex",
      requiresWrite,
      confidence: response.answers.target_agent.confidence ?? 1,
      probabilities: (response.answers.target_agent.probabilities as Record<string, number>) ?? {},
      complexity: response.answers.complexity.score ?? 1,
      model: response.model ?? "jev-latest",
    };
  } catch (err) {
    console.warn("[pi-cordis-toolbox] Jev evaluation failed, falling back to heuristic:", err);
    return fallbackJudge(goal);
  }
}
