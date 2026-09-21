import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PluginCatalog } from "../src/core/catalog.ts";
import { fallbackJudge, judgeTaskWithJev } from "../src/core/router.ts";

test("PluginCatalog supports kind and capability queries", async () => {
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const catalog = new PluginCatalog(packageRoot, process.cwd(), false);
  await catalog.refresh();

  const subagents = catalog.listByKind("subagent");
  assert.ok(subagents.length >= 2);
  const ids = subagents.map((s) => s.manifest.id);
  assert.ok(ids.includes("codex-subagent"));
  assert.ok(ids.includes("pi-subagent"));

  const piGeneral = catalog.listByCapability("pi general task");
  assert.equal(piGeneral.length, 1);
  assert.equal(piGeneral[0].manifest.id, "pi-subagent");
});

test("fallbackJudge generates structured JevPlan for deterministic tools", () => {
  const diffPlan = fallbackJudge("Compare diff between index.ts and backup.ts");
  assert.equal(diffPlan.executionMode, "deterministic_tools");
  assert.equal(diffPlan.requiresWrite, false);
  assert.ok(diffPlan.requiredPlugins.includes("toolkit-diff"));
});

test("fallbackJudge generates JevPlan for safe code writing with checkpoint", () => {
  const writePlan = fallbackJudge("Refactor and implement authentication logic in auth.ts");
  assert.equal(writePlan.targetAgent, "codex");
  assert.equal(writePlan.requiresWrite, true);
  assert.ok(writePlan.requiredPlugins.includes("checkpoint-rewind"));
  assert.ok(writePlan.requiredPlugins.includes("codex-subagent"));
});

test("fallbackJudge generates composite JevPlan when network and workspace writes combine", () => {
  const compositePlan = fallbackJudge("Fetch the latest Stripe API docs and implement the webhook handler");
  assert.equal(compositePlan.executionMode, "composite");
  assert.equal(compositePlan.requiresWrite, true);
  assert.equal(compositePlan.requiresNetwork, true);
  assert.ok(compositePlan.requiredPlugins.includes("checkpoint-rewind"));
  assert.ok(compositePlan.requiredPlugins.includes("webfetch"));
  assert.ok(compositePlan.requiredPlugins.includes("codex-subagent"));
});

test("Jev System One produces a multi-dimensional JevPlan when online", async () => {
  if (!process.env.TYPESAFE_API_KEY) {
    return;
  }

  const plan = await judgeTaskWithJev(
    "Fetch online documentation and implement the user registration controller",
    process.cwd(),
  );

  assert.ok(["direct_subagent", "composite", "deterministic_tools"].includes(plan.executionMode));
  assert.equal(typeof plan.requiresWrite, "boolean");
  assert.equal(typeof plan.requiresNetwork, "boolean");
  assert.ok(Array.isArray(plan.requiredPlugins));
  assert.ok(plan.confidence > 0);
});
