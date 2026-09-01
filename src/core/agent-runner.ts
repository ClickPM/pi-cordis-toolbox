import { Agent, type AgentEvent, type AgentOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { buildInternalSystemPrompt } from "./prompt.ts";
import { ToolboxRuntime } from "./runtime.ts";
import type { StreamRuntime } from "./types.ts";

function textFromAssistant(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function addUsage(target: ToolboxRuntime["details"]["usage"], usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.totalTokens += usage.totalTokens;
  target.cost += usage.cost.total;
}

function combineSignals(outer: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`toolbox_run timed out after ${timeoutMs}ms`)), timeoutMs);
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
  const { runtime, streamRuntime } = options;
  const combined = combineSignals(options.outerSignal, runtime.limits.timeoutMs);
  let agent!: Agent;
  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt: buildInternalSystemPrompt({
        cwd: runtime.cwd,
        limits: runtime.limits,
        policy: runtime.policy,
      }),
      model: streamRuntime.model,
      thinkingLevel: options.thinkingLevel,
      tools: runtime.refreshTools(),
    },
    streamFn: (model, context, streamOptions) => streamRuntime.streamSimple(model, context, streamOptions),
    getApiKey: streamRuntime.getApiKey,
    toolExecution: "sequential",
    shouldStopAfterTurn: () =>
      runtime.details.modelTurns >= runtime.limits.maxTurns ||
      runtime.details.operationCalls.length >= runtime.limits.maxOperations,
    beforeToolCall: async ({ toolCall }) => {
      combined.signal.throwIfAborted();
      if (runtime.details.operationCalls.length >= runtime.limits.maxOperations) {
        return { block: true, reason: "Toolbox operation budget exhausted.", terminate: true };
      }
      return undefined;
    },
    afterToolCall: async ({ toolCall, isError }) => {
      runtime.details.operationCalls.push({
        name: toolCall.name,
        callId: toolCall.id,
        isError,
      });
      return { details: undefined };
    },
    prepareNextTurnWithContext: (): { context: { systemPrompt: string; messages: any[]; tools: any[] } } => ({
      context: {
        systemPrompt: agent.state.systemPrompt,
        messages: agent.state.messages,
        tools: runtime.refreshTools(),
      },
    }),
  };
  agent = new Agent(agentOptions);

  let lastAssistant: AssistantMessage | undefined;
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "turn_end" && event.message.role === "assistant") {
      runtime.details.modelTurns += 1;
      lastAssistant = event.message;
      addUsage(runtime.details.usage, event.message.usage);
    }
  });

  const abortAgent = () => agent.abort();
  combined.signal.addEventListener("abort", abortAgent, { once: true });
  try {
    await agent.prompt(options.goal);
    if (combined.signal.aborted) {
      throw combined.signal.reason instanceof Error
        ? combined.signal.reason
        : new Error("toolbox_run aborted");
    }
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    const output = textFromAssistant(lastAssistant);
    if (!output) throw new Error("The internal toolbox agent returned no final text.");
    return output;
  } finally {
    combined.signal.removeEventListener("abort", abortAgent);
    combined.cancel();
  }
}
