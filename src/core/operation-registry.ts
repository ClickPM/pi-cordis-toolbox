import { Context, Service } from "@deepseek-ai/cordis";
import { Compile } from "typebox/compile";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type {
  OperationContext,
  OperationResult,
  ToolboxOperationDefinition,
  ToolboxPolicy,
} from "./types.ts";

export class OperationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationPolicyError";
  }
}

export class OperationRegistry extends Service {
  static provide = "toolboxOperations";
  private readonly operations = new Map<string, ToolboxOperationDefinition>();

  constructor(ctx: Context) {
    super(ctx, "toolboxOperations");
  }

  register<TSchemaType extends TSchema>(operation: ToolboxOperationDefinition<TSchemaType>): () => void {
    if (!/^[a-z][a-z0-9_.-]{1,100}$/.test(operation.name)) {
      throw new TypeError(`Invalid operation name: ${operation.name}`);
    }
    if (this.operations.has(operation.name)) {
      throw new Error(`Duplicate toolbox operation: ${operation.name}`);
    }
    this.operations.set(operation.name, operation as ToolboxOperationDefinition);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.operations.get(operation.name) === operation) {
        this.operations.delete(operation.name);
      }
    };
  }

  get(name: string): ToolboxOperationDefinition | undefined {
    return this.operations.get(name);
  }

  list(): ToolboxOperationDefinition[] {
    return [...this.operations.values()];
  }

  private checkPolicy(operation: ToolboxOperationDefinition, policy: ToolboxPolicy): void {
    const risk = operation.risk ?? "read-only";
    if (risk === "write" && !policy.allowWriteOperations) {
      throw new OperationPolicyError(`Operation "${operation.name}" is write-capable and is disabled by policy.`);
    }
    if (risk === "network" && !policy.allowNetworkOperations) {
      throw new OperationPolicyError(`Operation "${operation.name}" may access the network and is disabled by policy.`);
    }
    if (risk === "unsafe") {
      throw new OperationPolicyError(`Operation "${operation.name}" is marked unsafe and cannot run.`);
    }
  }

  async execute(
    name: string,
    params: unknown,
    context: OperationContext,
  ): Promise<OperationResult> {
    const operation = this.operations.get(name);
    if (!operation) throw new Error(`Unknown toolbox operation: ${name}`);
    context.signal.throwIfAborted();
    this.checkPolicy(operation, context.policy);
    const validator = Compile(operation.parameters);
    if (!validator.Check(params)) {
      const errors = [...validator.Errors(params)]
        .map((error) => `${("path" in error && error.path) || "root"}: ${error.message}`)
        .join("; ");
      throw new TypeError(`Invalid arguments for "${name}": ${errors}`);
    }
    const result = await operation.execute(params, context);
    context.signal.throwIfAborted();
    return result;
  }

  asAgentTools(getContext: () => OperationContext): AgentTool<any, any>[] {
    return this.list().map((operation) => ({
      name: operation.name,
      description: operation.description,
      parameters: operation.parameters,
      label: operation.label,
      executionMode: "sequential" as const,
      execute: async (toolCallId: string, params: Static<any>, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
        const operationContext = { ...getContext(), callId: toolCallId, signal: signal ?? getContext().signal };
        const result = await this.execute(operation.name, params, operationContext);
        return {
          content: [{ type: "text", text: result.content }],
          details: result.details ?? null,
        };
      },
    }));
  }
}

export function operationPlugin(ctx: Context): void {
  new OperationRegistry(ctx);
}
operationPlugin.provide = "toolboxOperations";
