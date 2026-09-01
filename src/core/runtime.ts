import { Context } from "@deepseek-ai/cordis";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PluginCatalog } from "./catalog.ts";
import { createMetaTools } from "./meta-tools.ts";
import { operationPlugin, OperationRegistry } from "./operation-registry.ts";
import { toolboxApiPlugin } from "./plugin-api.ts";
import { PluginLoader } from "./plugin-loader.ts";
import {
  DEFAULT_LIMITS,
  DEFAULT_POLICY,
  type ToolboxLimits,
  type ToolboxPolicy,
  type ToolboxRunDetails,
} from "./types.ts";

export interface ToolboxRuntimeOptions {
  packageRoot: string;
  cwd: string;
  model: Model<Api>;
  signal: AbortSignal;
  limits?: Partial<ToolboxLimits>;
  policy?: Partial<ToolboxPolicy>;
}

export class ToolboxRuntime {
  readonly root: Context;
  operations!: OperationRegistry;
  readonly catalog: PluginCatalog;
  loader!: PluginLoader;
  readonly limits: ToolboxLimits;
  readonly policy: ToolboxPolicy;
  readonly details: ToolboxRunDetails;
  private tools: AgentTool[] = [];
  private readonly baseFibers: Array<ReturnType<Context["plugin"]>> = [];
  private readonly signal: AbortSignal;
  private readonly packageRoot: string;
  readonly cwd: string;

  constructor(options: ToolboxRuntimeOptions) {
    this.cwd = options.cwd;
    this.signal = options.signal;
    this.packageRoot = options.packageRoot;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.details = {
      discoveredPlugins: [],
      loadedPlugins: [],
      operationCalls: [],
      modelTurns: 0,
      usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
      disposal: "failed",
    };
    this.root = new Context();
    this.catalog = new PluginCatalog(this.packageRoot, this.cwd, this.policy.allowProjectPlugins);
    // The runtime itself is the only initial Cordis composition. User plugins
    // are loaded later below this root and are disposed before the root.
    this.baseFibers.push(this.root.plugin(operationPlugin));
    this.baseFibers.push(this.root.plugin(toolboxApiPlugin));
  }

  async initialize(): Promise<void> {
    await Promise.all(this.baseFibers);
    this.operations = this.root.get("toolboxOperations") as OperationRegistry;
    if (!this.operations) throw new Error("Failed to initialize toolbox operation registry.");
    this.loader = new PluginLoader(this.root, this.catalog, this.operations);
    await this.catalog.refresh();
  }

  getTools(): AgentTool[] {
    return this.tools;
  }

  refreshTools(): AgentTool[] {
    const metaTools = createMetaTools({
      catalog: this.catalog,
      loader: this.loader,
      operations: this.operations,
      limits: this.limits,
      policy: this.policy,
      details: this.details,
      refreshTools: () => this.refreshTools().map((tool) => tool.name),
    });
    const operationTools = this.operations.asAgentTools(() => ({
      signal: this.signal,
      cwd: this.cwd,
      policy: this.policy,
      callId: "agent-operation",
      runtime: this.root,
    }));
    this.tools = [...metaTools, ...operationTools];
    return this.tools;
  }

  async dispose(): Promise<void> {
    try {
      if (this.loader) await this.loader.dispose();
    } finally {
      await this.root.fiber.dispose();
      this.details.disposal = "completed";
    }
  }
}
