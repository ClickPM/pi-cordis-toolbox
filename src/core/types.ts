import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Context as PiAiContext, Model } from "@earendil-works/pi-ai";
import type { Context as CordisContext, Fiber, Plugin } from "@deepseek-ai/cordis";
import type { TSchema } from "typebox";

export type JsonObject = Record<string, unknown>;

export interface ToolboxLimits {
  maxTurns: number;
  maxOperations: number;
  maxPlugins: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: ToolboxLimits = {
  maxTurns: 12,
  maxOperations: 24,
  maxPlugins: 8,
  timeoutMs: 120_000,
  maxOutputBytes: 50 * 1024,
};

export interface ToolboxPolicy {
  allowProjectPlugins: boolean;
  allowWriteOperations: boolean;
  allowNetworkOperations: boolean;
}

export const DEFAULT_POLICY: ToolboxPolicy = {
  allowProjectPlugins: true,
  allowWriteOperations: false,
  allowNetworkOperations: false,
};

export interface ToolboxRunInput {
  goal: string;
  cwd?: string;
  model?: Model<Api>;
  /** Optional trusted-package root override, primarily for embedding/tests. */
  packageRoot?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  limits?: Partial<ToolboxLimits>;
  policy?: Partial<ToolboxPolicy>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  keywords: string[];
  capabilities: string[];
  entry: string;
  readme?: string;
  references?: string[];
  risk?: "read-only" | "write" | "network" | "unsafe";
  requires?: string[];
}

export interface CatalogRecord {
  manifest: PluginManifest;
  rootDir: string;
  source: "package" | "project";
}

export interface LoadedPlugin {
  record: CatalogRecord;
  fiber: Fiber;
  operations: string[];
}

export interface ToolboxOperationDefinition<TSchemaType extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TSchemaType;
  execute: (params: unknown, context: OperationContext) => Promise<OperationResult>;
  risk?: "read-only" | "write" | "network" | "unsafe";
}

export interface OperationContext {
  signal: AbortSignal;
  cwd: string;
  policy: ToolboxPolicy;
  callId: string;
  runtime: CordisContext;
}

export interface OperationResult {
  content: string;
  details?: unknown;
  isError?: boolean;
}

export interface ToolboxPluginApi {
  registerOperation<TSchemaType extends TSchema>(
    operation: ToolboxOperationDefinition<TSchemaType>,
  ): void;
}

export type ToolboxPlugin = Plugin | ((ctx: CordisContext, config: unknown) => void | Promise<void>);

export interface ToolboxAgentTool extends AgentTool<any, any> {
  toolboxKind?: "meta" | "operation";
}

export interface ToolboxRunDetails {
  discoveredPlugins: Array<{ id: string; source: CatalogRecord["source"] }>;
  loadedPlugins: string[];
  operationCalls: Array<{
    name: string;
    callId: string;
    isError: boolean;
  }>;
  modelTurns: number;
  usage: {
    input: number;
    output: number;
    totalTokens: number;
    cost: number;
  };
  disposal: "completed" | "failed";
  error?: string;
}

export interface ToolboxRunResult extends AgentToolResult<ToolboxRunDetails> {
  details: ToolboxRunDetails;
}

export interface StreamRuntime {
  model: Model<Api>;
  streamSimple: (model: Model<Api>, context: PiAiContext, options?: any) => any;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}
