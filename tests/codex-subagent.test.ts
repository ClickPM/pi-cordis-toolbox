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

test("codex-subagent plugin discovery, loading, and disposal", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-cordis-codex-test-"));
  try {
    const runtime = new ToolboxRuntime({
      packageRoot: path.resolve(import.meta.dirname, ".."),
      cwd,
      model: fakeModel(),
      signal: new AbortController().signal,
    });
    await runtime.initialize();

    // 1. Discovery
    const matches = runtime.catalog.search("codex coding delegate");
    assert.ok(matches.some((m) => m.manifest.id === "codex-subagent"));

    const inspected = await runtime.catalog.inspect("codex-subagent", false);
    assert.equal(inspected.record.manifest.id, "codex-subagent");
    assert.ok(inspected.documentation?.includes("codex.ask"));

    // 2. Load plugin
    await runtime.loader.load("codex-subagent", runtime.limits.maxPlugins);
    assert.ok(runtime.operations.get("codex.ask"));
    assert.ok(runtime.operations.get("codex.execute"));

    // 3. Invoke codex.ask with local Codex CLI (read-only ping)
    const result = await runtime.operations.execute(
      "codex.ask",
      { prompt: "Reply with exactly: CODEX_TEST_VERIFIED" },
      {
        cwd,
        signal: new AbortController().signal,
        policy: runtime.policy,
        callId: "test-call-1",
        runtime: runtime.root,
      },
    );

    assert.ok(result.content.includes("CODEX_TEST_VERIFIED"));

    // 4. Dispose
    await runtime.loader.dispose();
    assert.equal(runtime.operations.get("codex.ask"), undefined);
    assert.equal(runtime.operations.get("codex.execute"), undefined);
    await runtime.dispose();
    assert.equal(runtime.details.disposal, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
