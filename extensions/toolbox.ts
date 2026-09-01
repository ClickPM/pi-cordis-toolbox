import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runToolbox } from "../src/index.ts";

export default function toolboxExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "toolbox_run",
    label: "Cordis Toolbox",
    description:
      "Use an ephemeral nested agent to discover, load, and orchestrate existing trusted Cordis atomic plugins. It cannot generate or execute new production code.",
    promptSnippet: "Run an intent-driven temporary Cordis toolbox composition.",
    promptGuidelines: [
      "Use toolbox_run when a task benefits from autonomous discovery and composition of trusted atomic plugins.",
      "toolbox_run is ephemeral: its internal plugins and operations are not registered as Pi tools and are disposed after each call.",
    ],
    parameters: Type.Object({
      goal: Type.String({
        minLength: 1,
        description: "The outcome to achieve. Describe the task and desired result, not an implementation plan.",
      }),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (!ctx.model) throw new Error("No active model is selected.");
      return runToolbox(
        { goal: params.goal },
        {
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
          currentModel: ctx.model,
          thinkingLevel: ctx.thinkingLevel,
          streamSimple: (model, context, options) => {
            const stream = createAssistantMessageEventStream();
            ctx.modelRegistry.complete(model, context, options as any).then(
              (message) => {
                if (message.stopReason === "aborted" || message.stopReason === "error") {
                  stream.push({ type: "error", reason: message.stopReason, error: message });
                } else {
                  stream.push({
                    type: "done",
                    reason: message.stopReason as "stop" | "length" | "toolUse" | "deferred",
                    message,
                  });
                }
              },
              (error) => {
                stream.push({
                  type: "error",
                  reason: "error",
                  error: {
                    role: "assistant",
                    content: [{ type: "text", text: "" }],
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    usage: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 0,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "error",
                    errorMessage: error instanceof Error ? error.message : String(error),
                    timestamp: Date.now(),
                  },
                });
              },
            );
            return stream;
          },
          getApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
        },
        signal,
      );
    },
  });
}
