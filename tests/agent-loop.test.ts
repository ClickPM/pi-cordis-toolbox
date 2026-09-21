import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { runNestedAgent } from "../src/core/agent-runner.ts";
import { fallbackJudge, judgeTaskWithJev } from "../src/core/router.ts";
import { ToolboxRuntime } from "../src/core/runtime.ts";

function isAgentCliAvailable(agent: "codex" | "cursor" | "pi"): boolean {
  try {
    if (agent === "codex") {
      const res = spawnSync("codex", ["--version"], { shell: true, timeout: 5000, stdio: "ignore" });
      return res.status === 0 && !res.error;
    }
    if (agent === "cursor") {
      const res = spawnSync("cursor-agent", ["--version"], { shell: true, timeout: 5000, stdio: "ignore" });
      return res.status === 0 && !res.error;
    }
    if (agent === "pi") {
      const res = spawnSync("pi", ["--version"], { shell: true, timeout: 5000, stdio: "ignore" });
      return res.status === 0 && !res.error;
    }
    return false;
  } catch {
    return false;
  }
}

function fakeModel(): Model<any> {
  return {
    id: "test-model",
    name: "Test model",
    api: "openai-completions",
    provider: "test",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };
}

test("fallback heuristic router correctly classifies intentions", () => {
  const codeTask = fallbackJudge("Implement user login and password encryption");
  assert.equal(codeTask.targetAgent, "codex");
  assert.equal(codeTask.requiresWrite, true);

  const docTask = fallbackJudge("Summarize the project README and architectural notes");
  assert.equal(docTask.targetAgent, "pi");
  assert.equal(docTask.requiresWrite, false);
});

test("Jev System One model autonomously routes tasks and evaluates write requirements", async () => {
  if (!process.env.TYPESAFE_API_KEY) {
    return;
  }

  const codeDecision = await judgeTaskWithJev(
    "Refactor and implement the database retry logic in db.ts",
    process.cwd(),
  );
  assert.equal(codeDecision.targetAgent, "codex");
  assert.equal(codeDecision.requiresWrite, true);
  assert.ok(codeDecision.confidence > 0.5);

  const docDecision = await judgeTaskWithJev(
    "Summarize and draft documentation for the flight search API endpoint",
    process.cwd(),
  );
  assert.equal(docDecision.targetAgent, "pi");
  assert.ok(docDecision.confidence > 0.5);
});

test("runNestedAgent routes via Jev and dispatches to chosen subagent", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-cordis-router-test-"));
  const model = fakeModel();
  const runtime = new ToolboxRuntime({
    packageRoot: path.resolve(import.meta.dirname, ".."),
    cwd,
    model,
    signal: new AbortController().signal,
  });

  try {
    await runtime.initialize();
    const decision = await judgeTaskWithJev("Reply with exactly: AGENT_RUNNER_VERIFIED", cwd);
    if (!isAgentCliAvailable(decision.targetAgent)) {
      t.diagnostic(`${decision.targetAgent} CLI not on PATH - skipped live dispatch`);
      return;
    }

    const result = await runNestedAgent({
      goal: "Reply with exactly: AGENT_RUNNER_VERIFIED",
      runtime,
      streamRuntime: {
        model,
        streamSimple: () => {
          throw new Error("unreachable");
        },
      },
      thinkingLevel: "off",
    });

    assert.ok(result.length > 0);
    assert.ok(runtime.details.routing);
    assert.ok(runtime.details.loadedPlugins.length > 0);
    assert.equal(runtime.details.operationCalls.length, 1);
  } finally {
    await runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
