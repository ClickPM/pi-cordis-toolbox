import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { runNestedAgent } from "../src/core/agent-runner.ts";
import { ToolboxRuntime } from "../src/core/runtime.ts";

const EMPTY_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function assistant(model: Model<any>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function mockStream(model: Model<any>) {
  let turn = 0;
  return (_model: Model<any>, context: Context) => {
    turn += 1;
    const stream = createAssistantMessageEventStream();
    let message: AssistantMessage;
    if (turn === 1) {
      message = assistant(model, [{
        type: "toolCall",
        id: "search-1",
        name: "catalog_search",
        arguments: { query: "text statistics" },
      }], "toolUse");
    } else if (turn === 2) {
      message = assistant(model, [{
        type: "toolCall",
        id: "load-1",
        name: "plugin_load",
        arguments: { pluginId: "text-tools" },
      }], "toolUse");
    } else if (turn === 3) {
      assert.ok(context.tools?.some((tool) => tool.name === "text.stats"));
      message = assistant(model, [{
        type: "toolCall",
        id: "stats-1",
        name: "text.stats",
        arguments: { text: "one two\nthree" },
      }], "toolUse");
    } else {
      message = assistant(model, [{ type: "text", text: "The text has 2 lines and 3 words." }], "stop");
    }
    queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }));
    return stream;
  };
}

test("nested agent discovers, loads, invokes, and later disposes an atomic plugin", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-cordis-toolbox-agent-"));
  const model = fakeModel();
  const runtime = new ToolboxRuntime({
    packageRoot: path.resolve(import.meta.dirname, ".."),
    cwd,
    model,
    signal: new AbortController().signal,
  });
  try {
    await runtime.initialize();
    const result = await runNestedAgent({
      goal: "Count lines and words in one two newline three",
      runtime,
      streamRuntime: { model, streamSimple: mockStream(model) },
      thinkingLevel: "off",
    });
    assert.equal(result, "The text has 2 lines and 3 words.");
    assert.deepEqual(runtime.details.loadedPlugins, ["text-tools"]);
    assert.equal(runtime.details.modelTurns, 4);
    assert.ok(runtime.details.operationCalls.some((call) => call.name === "text.stats"));
  } finally {
    await runtime.dispose();
    assert.equal(runtime.operations.get("text.stats"), undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});
