import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNestedAgent } from "../src/core/agent-runner.ts";
import { ToolboxRuntime } from "../src/core/runtime.ts";
import type { Model } from "@earendil-works/pi-ai";

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

test("E2E deterministic_tools mode executes diff without spawning any subagents", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-e2e-diff-"));
  const runtime = new ToolboxRuntime({
    packageRoot: path.resolve(import.meta.dirname, ".."),
    cwd: tmpDir,
    model: fakeModel(),
    signal: new AbortController().signal,
  });

  try {
    await runtime.initialize();

    // Create two test files in the workspace
    await fs.writeFile(path.join(tmpDir, "orig.txt"), "const val = 100;\nexport default val;\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "updated.txt"), "const val = 200;\nexport default val;\n", "utf8");

    const result = await runNestedAgent({
      goal: "Compare diff between 'orig.txt' and 'updated.txt'",
      runtime,
      streamRuntime: {
        model: fakeModel(),
        streamSimple: () => {
          throw new Error("No model stream should be called in deterministic mode");
        },
      },
      thinkingLevel: "off",
    });

    assert.ok(result.includes("- const val = 100;"));
    assert.ok(result.includes("+ const val = 200;"));
    assert.equal(runtime.details.modelTurns, 0, "Deterministic mode should not consume model turns");
    assert.ok(runtime.details.loadedPlugins.includes("toolkit-diff"));
    assert.ok(
      runtime.details.operationCalls.some((c) => c.name === "tool.diff"),
      "tool.diff must be invoked",
    );
  } finally {
    await runtime.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("E2E composite mode automatically snapshots and rolls back on execution failure", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-e2e-rollback-"));
  const runtime = new ToolboxRuntime({
    packageRoot: path.resolve(import.meta.dirname, ".."),
    cwd: tmpDir,
    model: fakeModel(),
    signal: new AbortController().signal,
    policy: {
      allowWriteOperations: true,
      allowNetworkOperations: true,
    },
  });

  try {
    await runtime.initialize();

    // 1. Initial file
    const secretFile = path.join(tmpDir, "secret.conf");
    await fs.writeFile(secretFile, "KEY=INITIAL_CLEAN_STATE", "utf8");

    // 2. Pre-load codex-subagent and intercept codex.execute to simulate a crash
    await runtime.loader.load("checkpoint-rewind", 5);
    await runtime.loader.load("codex-subagent", 5);
    runtime.details.loadedPlugins.push("checkpoint-rewind", "codex-subagent");

    const codexOp = runtime.operations.get("codex.execute");
    assert.ok(codexOp);
    codexOp.execute = async () => {
      // Dirty write
      await fs.writeFile(secretFile, "KEY=DIRTY_UNINTENDED_CHANGE", "utf8");
      await fs.writeFile(path.join(tmpDir, "garbage.tmp"), "should be deleted", "utf8");
      throw new Error("Simulated subagent crash midway through task");
    };

    // 3. Trigger composite task (contains write and network words to trigger composite mode)
    await assert.rejects(
      async () => {
        await runNestedAgent({
          goal: "Fetch https://example.com/api and refactor the backend database config",
          runtime,
          streamRuntime: {
            model: fakeModel(),
            streamSimple: () => {
              throw new Error("unreachable");
            },
          },
          thinkingLevel: "off",
        });
      },
      /Transaction automatically rolled back/,
    );

    // 4. Verify transaction safety: the dirty changes must be reverted!
    const revertedContent = await fs.readFile(secretFile, "utf8");
    assert.equal(
      revertedContent,
      "KEY=INITIAL_CLEAN_STATE",
      "File content must be restored to checkpoint state",
    );

    // 5. Verify garbage file created during failure was removed
    await assert.rejects(
      async () => {
        await fs.access(path.join(tmpDir, "garbage.tmp"));
      },
      /ENOENT/,
      "New files created by failed subagent must be removed on rollback",
    );

    // 6. Verify operation audit log
    assert.ok(runtime.details.operationCalls.some((c) => c.name === "checkpoint.create"));
    assert.ok(runtime.details.operationCalls.some((c) => c.name === "checkpoint.rollback"));
  } finally {
    await runtime.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
