import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test("toolkit-diff plugin accurately computes unified diff and summary", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-diff-"));
  const runtime = new ToolboxRuntime({
    packageRoot: path.resolve(import.meta.dirname, ".."),
    cwd: tmpDir,
    model: fakeModel(),
    signal: new AbortController().signal,
  });

  try {
    await runtime.initialize();
    await runtime.loader.load("toolkit-diff", 5);

    const op = runtime.operations.get("tool.diff");
    assert.ok(op, "tool.diff operation should be registered");

    const opContext = {
      signal: new AbortController().signal,
      cwd: tmpDir,
      policy: runtime.policy,
      callId: "test-call",
      runtime: runtime.root,
    };

    // 1. Text diff
    const sourceText = "line 1\nline 2\nline 3";
    const targetText = "line 1\nline 2 modified\nline 3\nline 4";
    const resUnified = await op.execute(
      { source: sourceText, target: targetText, isPath: false, format: "unified" },
      opContext,
    );
    assert.ok(resUnified.content.includes("+ line 2 modified"));
    assert.ok(resUnified.content.includes("- line 2"));
    assert.ok(resUnified.content.includes("+ line 4"));

    // 2. Summary format
    const resSummary = await op.execute(
      { source: sourceText, target: targetText, isPath: false, format: "summary" },
      opContext,
    );
    assert.ok(resSummary.content.includes("Added lines:"));
    assert.ok(resSummary.content.includes("Deleted lines:"));

    // 3. File path diff
    const fileA = path.join(tmpDir, "fileA.txt");
    const fileB = path.join(tmpDir, "fileB.txt");
    await fs.writeFile(fileA, "foo\nbar", "utf8");
    await fs.writeFile(fileB, "foo\nbaz", "utf8");

    const resFiles = await op.execute(
      { source: "fileA.txt", target: "fileB.txt", isPath: true },
      opContext,
    );
    assert.ok(resFiles.content.includes("- bar"));
    assert.ok(resFiles.content.includes("+ baz"));
  } finally {
    await runtime.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("webfetch plugin enforces SSRF protection against private addresses", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-webfetch-"));
  const runtime = new ToolboxRuntime({
    packageRoot: path.resolve(import.meta.dirname, ".."),
    cwd: tmpDir,
    model: fakeModel(),
    signal: new AbortController().signal,
    policy: {
      allowNetworkOperations: true,
    },
  });

  try {
    await runtime.initialize();
    await runtime.loader.load("webfetch", 5);

    const op = runtime.operations.get("web.fetch");
    assert.ok(op, "web.fetch should be registered");

    const opContext = {
      signal: new AbortController().signal,
      cwd: tmpDir,
      policy: runtime.policy,
      callId: "test-fetch",
      runtime: runtime.root,
    };

    // SSRF on localhost
    await assert.rejects(
      async () => {
        await op.execute({ url: "http://127.0.0.1:8080/api" }, opContext);
      },
      /SSRF blocked/,
    );

    // SSRF on private class C IP
    await assert.rejects(
      async () => {
        await op.execute({ url: "http://192.168.1.100/admin" }, opContext);
      },
      /SSRF blocked/,
    );
  } finally {
    await runtime.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("checkpoint-rewind creates workspace snapshot and rolls back changes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-checkpoint-"));
  const runtime = new ToolboxRuntime({
    packageRoot: path.resolve(import.meta.dirname, ".."),
    cwd: tmpDir,
    model: fakeModel(),
    signal: new AbortController().signal,
    policy: {
      allowWriteOperations: true,
    },
  });

  try {
    await runtime.initialize();
    await runtime.loader.load("checkpoint-rewind", 5);

    const opCreate = runtime.operations.get("checkpoint.create");
    const opRollback = runtime.operations.get("checkpoint.rollback");
    assert.ok(opCreate);
    assert.ok(opRollback);

    const opContext = {
      signal: new AbortController().signal,
      cwd: tmpDir,
      policy: runtime.policy,
      callId: "test-cp",
      runtime: runtime.root,
    };

    // Checkpoint service is also accessible via Cordis context!
    const cpService = runtime.root.get("checkpoint");
    assert.ok(cpService);

    // Prepare initial file
    const initialFile = path.join(tmpDir, "config.json");
    await fs.writeFile(initialFile, JSON.stringify({ version: "1.0.0" }), "utf8");

    // 1. Create checkpoint via service or operation
    const createRes = await opCreate.execute({ label: "initial-state" }, opContext);
    const cpId = (createRes.details as { id: string }).id;
    assert.ok(cpId);

    // 2. Modify existing file & create a new uncommitted file
    await fs.writeFile(initialFile, JSON.stringify({ version: "2.0.0-dirty" }), "utf8");
    const newFile = path.join(tmpDir, "temp-junk.txt");
    await fs.writeFile(newFile, "junk data", "utf8");

    // 3. Execute rollback
    const rollbackRes = await opRollback.execute({ id: cpId }, opContext);
    assert.ok(rollbackRes.content.includes("Rollback successful"));

    // 4. Verify original file content is restored
    const restoredContent = await fs.readFile(initialFile, "utf8");
    assert.equal(JSON.parse(restoredContent).version, "1.0.0");
  } finally {
    await runtime.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
