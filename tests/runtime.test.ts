import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { ToolboxRuntime } from "../src/core/runtime.ts";

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

test("catalog is progressive and subagent plugin disposal removes registered operations", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-cordis-toolbox-test-"));
  try {
    const runtime = new ToolboxRuntime({
      packageRoot: path.resolve(import.meta.dirname, ".."),
      cwd,
      model: fakeModel(),
      signal: new AbortController().signal,
    });
    await runtime.initialize();
    assert.deepEqual(runtime.operations.list(), []);

    // Verify subagent discovery
    const cursorMatches = runtime.catalog.search("cursor navigation search");
    assert.ok(cursorMatches.some((m) => m.manifest.id === "cursor-subagent"));

    const piMatches = runtime.catalog.search("pi research documentation");
    assert.ok(piMatches.some((m) => m.manifest.id === "pi-subagent"));

    // Load cursor subagent
    await runtime.loader.load("cursor-subagent", runtime.limits.maxPlugins);
    assert.ok(runtime.operations.get("cursor.ask"));
    assert.ok(runtime.operations.get("cursor.execute"));

    // Disposal removes operations
    await runtime.loader.dispose();
    assert.equal(runtime.operations.get("cursor.ask"), undefined);
    assert.equal(runtime.operations.get("cursor.execute"), undefined);

    await runtime.dispose();
    assert.equal(runtime.details.disposal, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("subagent rejects escaping target workdir", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-cordis-toolbox-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-cordis-toolbox-outside-"));
  try {
    const runtime = new ToolboxRuntime({
      packageRoot: path.resolve(import.meta.dirname, ".."),
      cwd,
      model: fakeModel(),
      signal: new AbortController().signal,
    });
    await runtime.initialize();
    await runtime.loader.load("cursor-subagent", runtime.limits.maxPlugins);

    await assert.rejects(
      () =>
        runtime.operations.execute(
          "cursor.ask",
          { prompt: "ping", workdir: path.join("..", path.basename(outside)) },
          {
            cwd,
            policy: runtime.policy,
            callId: "test-boundary",
            signal: new AbortController().signal,
            runtime: runtime.root,
          },
        ),
      /escapes the workspace/,
    );

    await runtime.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
