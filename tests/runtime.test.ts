import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("catalog is progressive and plugin disposal removes registered operations", async () => {
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
    const matches = runtime.catalog.search("read workspace");
    assert.equal(matches[0]?.manifest.id, "workspace-read");
    await runtime.loader.load("workspace-read", runtime.limits.maxPlugins);
    assert.ok(runtime.operations.get("workspace.read_file"));
    await runtime.loader.dispose();
    assert.equal(runtime.operations.get("workspace.read_file"), undefined);
    await runtime.dispose();
    assert.equal(runtime.details.disposal, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace plugin enforces workspace boundary", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-cordis-toolbox-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-cordis-toolbox-outside-"));
  try {
    await writeFile(path.join(cwd, "inside.txt"), "inside\nsecond\n", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const runtime = new ToolboxRuntime({
      packageRoot: path.resolve(import.meta.dirname, ".."),
      cwd,
      model: fakeModel(),
      signal: new AbortController().signal,
    });
    await runtime.initialize();
    await runtime.loader.load("workspace-read", runtime.limits.maxPlugins);
    const result = await runtime.operations.execute("workspace.read_file", { path: "inside.txt" }, {
      cwd,
      policy: runtime.policy,
      callId: "test",
      signal: new AbortController().signal,
      runtime: runtime.root,
    });
    assert.match(result.content, /inside/);
    await assert.rejects(() => runtime.operations.execute("workspace.read_file", { path: path.join(outside, "secret.txt") }, {
      cwd,
      policy: runtime.policy,
      callId: "test",
      signal: new AbortController().signal,
      runtime: runtime.root,
    }), /outside the workspace/);
    await runtime.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
