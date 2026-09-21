import { judgeTaskWithJev } from "./router.ts";
import { ToolboxRuntime } from "./runtime.ts";
import type { JevPlan, OperationContext, StreamRuntime } from "./types.ts";

function combineSignals(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error(`toolbox_run timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const signal = outer
    ? AbortSignal.any([outer, timeoutController.signal])
    : timeoutController.signal;
  return { signal, cancel: () => clearTimeout(timer) };
}

export interface RunNestedAgentOptions {
  goal: string;
  runtime: ToolboxRuntime;
  streamRuntime: StreamRuntime;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  outerSignal?: AbortSignal;
}

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s"'<>\)]+/g;
  const matches = text.match(urlRegex);
  return matches ? [...new Set(matches)] : [];
}

function extractDiffTargets(text: string): { source: string; target: string } | undefined {
  const quotesMatch = /['"`]([^'"`]+)['"`]\s*(?:and|to|with|vs|与|和)?\s*['"`]([^'"`]+)['"`]/i.exec(text);
  if (quotesMatch) {
    return { source: quotesMatch[1], target: quotesMatch[2] };
  }
  const betweenMatch =
    /(?:between|compare|diff|对比|比较)\s+([^\s,]+)\s+(?:and|with|to|vs|和|与)\s+([^\s,]+)/i.exec(text);
  if (betweenMatch) {
    return { source: betweenMatch[1], target: betweenMatch[2] };
  }
  return undefined;
}

async function executeDeterministicTools(
  plan: JevPlan,
  goal: string,
  runtime: ToolboxRuntime,
  opContext: OperationContext,
): Promise<string> {
  // If toolkit-diff is loaded and goal mentions diff/compare
  if (runtime.operations.get("tool.diff")) {
    const targets = extractDiffTargets(goal);
    if (targets) {
      const res = await runtime.operations.execute(
        "tool.diff",
        { source: targets.source, target: targets.target, format: "unified" },
        opContext,
      );
      runtime.details.operationCalls.push({
        name: "tool.diff",
        callId: opContext.callId,
        isError: !!res.isError,
      });
      return res.content;
    }
  }

  // Fallback to first registered operation if specific tool match was ambiguous
  const availableOps = runtime.operations.list();
  if (availableOps.length > 0) {
    const op = availableOps[0];
    const payload =
      op.name.startsWith("codex.") || op.name.startsWith("pi.")
        ? { prompt: goal }
        : { source: goal, target: goal };
    const res = await runtime.operations.execute(op.name, payload, opContext);
    runtime.details.operationCalls.push({
      name: op.name,
      callId: opContext.callId,
      isError: !!res.isError,
    });
    return res.content;
  }

  throw new Error("Deterministic execution mode selected, but no matching utility operations were found.");
}

export async function runNestedAgent(options: RunNestedAgentOptions): Promise<string> {
  const { runtime } = options;
  const combined = combineSignals(options.outerSignal, runtime.limits.timeoutMs);

  try {
    combined.signal.throwIfAborted();

    // 1. Multi-dimensional intent composition via Jev System One
    const plan = await judgeTaskWithJev(options.goal, runtime.cwd);
    runtime.details.routing = plan;

    // 2. Discover and dynamically load the required plugin topology (filtered by policy)
    for (const pluginId of plan.requiredPlugins) {
      const rec = runtime.catalog.get(pluginId);
      if (!rec) continue;
      const risk = rec.manifest.risk ?? "read-only";
      if (risk === "write" && !runtime.policy.allowWriteOperations) continue;
      if (risk === "network" && !runtime.policy.allowNetworkOperations) continue;
      if (risk === "unsafe") continue;

      if (!runtime.details.loadedPlugins.includes(pluginId)) {
        await runtime.loader.load(pluginId, runtime.limits.maxPlugins);
        runtime.details.loadedPlugins.push(pluginId);
      }
    }

    // Ensure at least one policy-eligible plugin is loaded as fallback
    if (runtime.details.loadedPlugins.length === 0) {
      const eligible = runtime.catalog.list().filter((r) => {
        const risk = r.manifest.risk ?? "read-only";
        if (risk === "write" && !runtime.policy.allowWriteOperations) return false;
        if (risk === "network" && !runtime.policy.allowNetworkOperations) return false;
        if (risk === "unsafe") return false;
        return true;
      });
      if (eligible.length === 0) {
        throw new Error("No policy-eligible plugins available in toolbox catalog.");
      }
      const fallbackRecord = eligible[0];
      await runtime.loader.load(fallbackRecord.manifest.id, runtime.limits.maxPlugins);
      runtime.details.loadedPlugins.push(fallbackRecord.manifest.id);
    }

    const opContext: OperationContext = {
      signal: combined.signal,
      cwd: runtime.cwd,
      policy: runtime.policy,
      callId: `jev-${plan.executionMode}-${Date.now()}`,
      runtime: runtime.root,
    };

    // 3. Branch execution based on JevPlan executionMode

    // --- Mode A: Pure Deterministic Utility Tools ---
    if (plan.executionMode === "deterministic_tools") {
      const content = await executeDeterministicTools(plan, options.goal, runtime, opContext);
      runtime.details.modelTurns = 0;
      return content;
    }

    // --- Mode B & C: Subagent & Composite Workflow ---
    let effectivePrompt = options.goal;
    let checkpointId: string | undefined;

    // Composite Step 1: Create transaction checkpoint before modifying workspace
    if (
      plan.requiresWrite &&
      runtime.operations.get("checkpoint.create") &&
      runtime.policy.allowWriteOperations
    ) {
      try {
        const cpRes = await runtime.operations.execute(
          "checkpoint.create",
          { label: `Auto-checkpoint before: ${options.goal.slice(0, 50)}` },
          opContext,
        );
        runtime.details.operationCalls.push({
          name: "checkpoint.create",
          callId: opContext.callId,
          isError: !!cpRes.isError,
        });
        if (cpRes.details && typeof cpRes.details === "object" && "id" in cpRes.details) {
          checkpointId = (cpRes.details as { id: string }).id;
        }
      } catch (cpErr) {
        console.warn("[pi-cordis-toolbox] Failed to create pre-execution checkpoint:", cpErr);
      }
    }

    // Composite Step 2: Fetch network references if required
    if (
      plan.requiresNetwork &&
      runtime.operations.get("web.fetch") &&
      runtime.policy.allowNetworkOperations
    ) {
      const urls = extractUrls(options.goal);
      if (urls.length > 0) {
        try {
          const fetchRes = await runtime.operations.execute(
            "web.fetch",
            { url: urls[0], format: "markdown" },
            opContext,
          );
          runtime.details.operationCalls.push({
            name: "web.fetch",
            callId: opContext.callId,
            isError: !!fetchRes.isError,
          });
          if (fetchRes.content && !fetchRes.isError) {
            effectivePrompt = `${options.goal}\n\n[Reference documentation fetched from ${urls[0]}]:\n${fetchRes.content}`;
          }
        } catch (fetchErr) {
          console.warn(`[pi-cordis-toolbox] Web fetch failed for ${urls[0]}:`, fetchErr);
        }
      }
    }

    // Composite Step 3: Resolve the appropriate subagent operation
    const targetAgent = plan.targetAgent ?? "codex";
    let opName = plan.requiresWrite
      ? `${targetAgent}.execute`
      : targetAgent === "pi"
        ? "pi.run"
        : `${targetAgent}.ask`;

    if (!runtime.operations.get(opName)) {
      const allOps = runtime.operations.list();
      const subagentOp = allOps.find((op) => op.name.startsWith("codex.") || op.name.startsWith("pi."));
      if (subagentOp) {
        opName = subagentOp.name;
      } else if (allOps.length > 0) {
        opName = allOps[0].name;
      } else {
        throw new Error("No operations available to execute subagent task.");
      }
    }

    // Composite Step 4: Execute with Transaction Rollback on Failure
    try {
      const result = await runtime.operations.execute(
        opName,
        { prompt: effectivePrompt },
        opContext,
      );

      runtime.details.operationCalls.push({
        name: opName,
        callId: opContext.callId,
        isError: !!result.isError,
      });
      runtime.details.modelTurns = 1;

      if (result.isError) {
        throw new Error(`Subagent "${opName}" execution failed: ${result.content}`);
      }

      if (!result.content || result.content.trim() === "") {
        throw new Error(`Subagent "${opName}" returned empty content.`);
      }

      return result.content;
    } catch (execError) {
      // Transaction Safety: Automatically rollback if checkpoint was created
      if (checkpointId && runtime.operations.get("checkpoint.rollback")) {
        let rolledBack = false;
        try {
          await runtime.operations.execute(
            "checkpoint.rollback",
            { id: checkpointId },
            opContext,
          );
          runtime.details.operationCalls.push({
            name: "checkpoint.rollback",
            callId: opContext.callId,
            isError: false,
          });
          rolledBack = true;
        } catch (rbErr) {
          console.error("[pi-cordis-toolbox] Rollback execution failed:", rbErr);
        }

        if (rolledBack) {
          const originalMessage = execError instanceof Error ? execError.message : String(execError);
          throw new Error(
            `${originalMessage} (Transaction automatically rolled back to checkpoint [${checkpointId}])`,
          );
        }
      }
      throw execError;
    }
  } finally {
    combined.cancel();
  }
}
