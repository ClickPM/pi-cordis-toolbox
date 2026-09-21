import path from "node:path";
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import type { ExecutionMode, JevPlan } from "./types.ts";

export function fallbackJudge(goal: string): JevPlan {
  const lower = goal.toLowerCase();
  const requiresWrite = /write|create|modify|edit|implement|fix|refactor|add|delete|remove|update|写|改|加|修复|创建|实现/.test(
    lower,
  );
  const requiresNetwork = /fetch|http|url|curl|api|web|download|联网|抓取|获取网页|下载/.test(
    lower,
  );
  const isDiffOrCompare = /diff|compare|比较|对比/.test(lower);
  const isDocOrResearch = /doc|summary|summarize|explain|readme|research|文档|总结|总结一下|调研/.test(
    lower,
  );

  let targetAgent: "codex" | "pi" = "codex";
  if (isDocOrResearch && !requiresWrite) {
    targetAgent = "pi";
  }

  let executionMode: ExecutionMode = "direct_subagent";
  if (isDiffOrCompare && !requiresWrite && !/implement|fix|refactor|写|实现|修复/.test(lower)) {
    executionMode = "deterministic_tools";
  } else if ((requiresWrite && requiresNetwork) || (requiresWrite && isDocOrResearch)) {
    executionMode = "composite";
  }

  const requiredPlugins: string[] = [];
  if (requiresWrite) {
    requiredPlugins.push("checkpoint-rewind");
  }
  if (requiresNetwork) {
    requiredPlugins.push("webfetch");
  }
  if (isDiffOrCompare) {
    requiredPlugins.push("toolkit-diff");
  }
  if (executionMode !== "deterministic_tools" || requiredPlugins.length === 0) {
    requiredPlugins.push(`${targetAgent}-subagent`);
  }

  return {
    model: "heuristic-fallback",
    executionMode,
    targetAgent,
    requiredPlugins: [...new Set(requiredPlugins)],
    requiresWrite,
    requiresNetwork,
    confidence: 0.7,
    probabilities: { [targetAgent]: 0.7 },
    complexity: executionMode === "composite" ? 2 : 1,
    reasoning: `Heuristic fallback routed to ${executionMode} with ${requiredPlugins.join(", ")}`,
  };
}

export async function judgeTaskWithJev(goal: string, cwd: string): Promise<JevPlan> {
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
        execution_mode: choice(
          "How should this task be orchestrated?",
          {
            deterministic_tools:
              "Pure deterministic utility tools (e.g. diff comparison, text parsing, JSON inspection) without deep LLM coding",
            direct_subagent:
              "Direct autonomous subagent execution (e.g. code generation, deep investigation, documentation)",
            composite:
              "Composite multi-plugin workflow (e.g. fetch docs + implement, or safe refactor with checkpoint rollback)",
          },
        ),
        target_agent: choice(
          "Which specialized autonomous agent is best suited to handle this task?",
          {
            codex: "Code generation, code analysis, bug fixing, test writing, refactoring, implementation",
            pi: "General reconnaissance, research, documentation drafting, bash/terminal automation, high-level summaries",
            none: "No subagent required (deterministic utility pipeline only)",
          },
        ),
        requires_write: noul(
          "Does this task require writing, editing, modifying, or creating files in the workspace?",
        ),
        requires_network: noul(
          "Does this task require fetching external web pages, URLs, or network APIs?",
        ),
        complexity: score("How complex is this task?", [
          "Simple lookup or single deterministic operation",
          "Moderate targeted task",
          "Complex multi-file or composite workflow",
        ]),
      },
    });

    const modeChoice = response.answers.execution_mode.choice as ExecutionMode;
    const agentRaw = response.answers.target_agent.choice;
    let targetAgent: "codex" | "pi" | undefined;
    if (agentRaw === "codex" || agentRaw === "pi") {
      targetAgent = agentRaw;
    } else if (modeChoice !== "deterministic_tools") {
      targetAgent = "codex";
    }

    const requiresWrite = (response.answers.requires_write.noul ?? 0) >= 0.5;
    const requiresNetwork = (response.answers.requires_network.noul ?? 0) >= 0.5;

    const isDiffOrCompare = /diff|compare|比较|对比/i.test(goal);
    const requiredPlugins: string[] = [];
    if (requiresWrite) {
      requiredPlugins.push("checkpoint-rewind");
    }
    if (requiresNetwork) {
      requiredPlugins.push("webfetch");
    }
    if (isDiffOrCompare) {
      requiredPlugins.push("toolkit-diff");
    }
    if (targetAgent && modeChoice !== "deterministic_tools") {
      requiredPlugins.push(`${targetAgent}-subagent`);
    } else if (requiredPlugins.length === 0) {
      requiredPlugins.push(`${targetAgent ?? "codex"}-subagent`);
    }

    return {
      model: response.model ?? "jev-latest",
      executionMode: modeChoice ?? "direct_subagent",
      targetAgent: targetAgent ?? "codex",
      requiredPlugins: [...new Set(requiredPlugins)],
      requiresWrite,
      requiresNetwork,
      confidence: response.answers.target_agent.confidence ?? 1,
      probabilities: (response.answers.target_agent.probabilities as Record<string, number>) ?? {},
      complexity: response.answers.complexity.score ?? 1,
      reasoning: `Jev decided mode: ${modeChoice}, agent: ${targetAgent ?? "none"}, write: ${requiresWrite}, network: ${requiresNetwork}`,
    };
  } catch (err) {
    console.warn("[pi-cordis-toolbox] Jev evaluation failed, falling back to heuristic:", err);
    return fallbackJudge(goal);
  }
}
