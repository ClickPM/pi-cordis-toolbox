import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { runToolbox } from "../src/index.ts";

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

test("toolbox facade rejects a cwd different from the active host", async () => {
  const hostCwd = process.cwd();
  await assert.rejects(
    () => runToolbox(
      { goal: "inspect something", cwd: hostCwd + "-other" },
      {
        cwd: hostCwd,
        projectTrusted: false,
        currentModel: fakeModel(),
        streamSimple: () => {
          throw new Error("must not call model");
        },
      },
    ),
    /must match the active Pi working directory/,
  );
});
