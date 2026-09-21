import { judgeTaskWithJev } from "./router.ts";
import { ToolboxRuntime } from "./runtime.ts";
import type { OperationContext, StreamRuntime } from "./types.ts";

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

export async function runNestedAgent(options: RunNestedAgentOptions): Promise<string> {
  const { runtime } = options;
  const combined = combineSignals(options.outerSignal, runtime.limits.timeoutMs);

  try {
    combined.signal.throwIfAborted();

    // 1. Autonomous judgment using Jev System One model
    const decision = await judgeTaskWithJev(options.goal, runtime.cwd);
    runtime.details.routing = decision;

    // 2. Discover and dynamically load the chosen specialized subagent plugin
    const targetPluginId = `${decision.targetAgent}-subagent`;
    let record = runtime.catalog.get(targetPluginId);

    if (!record) {
      const available = runtime.catalog.list();
      if (available.length === 0) {
        throw new Error("No subagent plugins found in toolbox catalog.");
      }
      record = available[0];
    }

    await runtime.loader.load(record.manifest.id, runtime.limits.maxPlugins);
    if (!runtime.details.loadedPlugins.includes(record.manifest.id)) {
      runtime.details.loadedPlugins.push(record.manifest.id);
    }

    // 3. Resolve the exact operation (read-only vs write)
    let opName = decision.requiresWrite
      ? `${decision.targetAgent}.execute`
      : decision.targetAgent === "pi"
        ? "pi.run"
        : `${decision.targetAgent}.ask`;

    // Fallback if specific operation does not exist on current plugin
    if (!runtime.operations.get(opName)) {
      const allOps = runtime.operations.list();
      if (allOps.length === 0) {
        throw new Error(`Plugin "${record.manifest.id}" did not register any operations.`);
      }
      opName = allOps[0].name;
    }

    // 4. Execute the operation in the Cordis lifecycle scope
    const opContext: OperationContext = {
      signal: combined.signal,
      cwd: runtime.cwd,
      policy: runtime.policy,
      callId: `jev-${decision.targetAgent}-${Date.now()}`,
      runtime: runtime.root,
    };

    const result = await runtime.operations.execute(
      opName,
      { prompt: options.goal },
      opContext,
    );

    runtime.details.operationCalls.push({
      name: opName,
      callId: opContext.callId,
      isError: !!result.isError,
    });
    runtime.details.modelTurns = 1;

    if (!result.content || result.content.trim() === "") {
      throw new Error(`Subagent "${opName}" returned empty content.`);
    }

    return result.content;
  } finally {
    combined.cancel();
  }
}
