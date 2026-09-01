import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Context as PiAiContext, Model } from "@earendil-works/pi-ai";
import { runNestedAgent } from "./core/agent-runner.ts";
import { ToolboxRuntime } from "./core/runtime.ts";
import type { StreamRuntime, ToolboxRunInput, ToolboxRunResult } from "./core/types.ts";

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return `${text.slice(0, end)}\n\n[toolbox_run output truncated]`;
}

export interface ToolboxHost {
  cwd: string;
  projectTrusted: boolean;
  currentModel?: Model<Api>;
  thinkingLevel?: ToolboxRunInput["thinkingLevel"];
  streamSimple(model: Model<Api>, context: PiAiContext, options?: unknown): unknown;
  getApiKey?(provider: string): Promise<string | undefined> | string | undefined;
}

export async function runToolbox(
  input: ToolboxRunInput,
  host: ToolboxHost,
  signal?: AbortSignal,
): Promise<ToolboxRunResult> {
  const goal = input.goal.trim();
  if (!goal) throw new TypeError("toolbox_run requires a non-empty goal.");
  const model = input.model ?? host.currentModel;
  if (!model) throw new Error("No model is selected for the nested toolbox agent.");
  const requestedCwd = path.resolve(input.cwd ?? host.cwd);
  const hostCwd = path.resolve(host.cwd);
  if (requestedCwd !== hostCwd) {
    throw new Error("toolbox_run cwd must match the active Pi working directory.");
  }

  const runtime = new ToolboxRuntime({
    packageRoot: input.packageRoot ?? PACKAGE_ROOT,
    cwd: requestedCwd,
    model,
    signal: signal ?? new AbortController().signal,
    limits: input.limits,
    policy: {
      ...input.policy,
      allowProjectPlugins: host.projectTrusted && input.policy?.allowProjectPlugins !== false,
      allowWriteOperations: false,
      allowNetworkOperations: false,
    },
  });

  let content = "";
  let thrown: unknown;
  try {
    await runtime.initialize();
    const streamRuntime: StreamRuntime = {
      model,
      streamSimple: host.streamSimple.bind(host) as StreamRuntime["streamSimple"],
      getApiKey: host.getApiKey?.bind(host),
    };
    content = await runNestedAgent({
      goal,
      runtime,
      streamRuntime,
      thinkingLevel: input.thinkingLevel ?? host.thinkingLevel ?? "medium",
      outerSignal: signal,
    });
  } catch (error) {
    thrown = error;
    runtime.details.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await runtime.dispose();
    } catch (disposeError) {
      runtime.details.disposal = "failed";
      const message = disposeError instanceof Error ? disposeError.message : String(disposeError);
      runtime.details.error = runtime.details.error
        ? `${runtime.details.error}; disposal: ${message}`
        : `disposal: ${message}`;
      if (!thrown) thrown = disposeError;
    }
  }

  if (thrown) throw thrown;
  return {
    content: [{ type: "text", text: truncateUtf8(content, runtime.limits.maxOutputBytes) }],
    details: runtime.details,
  };
}

export * from "./core/types.ts";
export * from "./core/operation-registry.ts";
