import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { PluginCatalog } from "./catalog.ts";
import { PluginLoader, serializeRecord } from "./plugin-loader.ts";
import type { OperationRegistry } from "./operation-registry.ts";
import type { ToolboxLimits, ToolboxPolicy, ToolboxRunDetails } from "./types.ts";

function jsonResult(value: unknown, addedToolNames?: string[]): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
    addedToolNames,
  };
}

export function createMetaTools(options: {
  catalog: PluginCatalog;
  loader: PluginLoader;
  operations: OperationRegistry;
  limits: ToolboxLimits;
  policy: ToolboxPolicy;
  details: ToolboxRunDetails;
  refreshTools: () => string[];
}): AgentTool[] {
  const { catalog, loader, operations, limits, policy, details, refreshTools } = options;

  return [
    {
      name: "catalog_search",
      label: "Search toolbox catalog",
      description:
        "Search trusted plugin metadata for capabilities relevant to the goal. This reads manifests only and does not load code.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const input = params as { query: string; limit?: number };
        const matches = catalog.search(input.query, input.limit ?? 8);
        for (const record of matches) {
          if (!details.discoveredPlugins.some((item) => item.id === record.manifest.id)) {
            details.discoveredPlugins.push({ id: record.manifest.id, source: record.source });
          }
        }
        return jsonResult({ matches: matches.map(serializeRecord) });
      },
    },
    {
      name: "catalog_inspect",
      label: "Inspect toolbox plugin",
      description:
        "Read a plugin manifest and its PLUGIN.md documentation. Use after catalog_search and before loading when behavior or constraints are unclear.",
      parameters: Type.Object({
        pluginId: Type.String({ minLength: 2 }),
        includeReferences: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const input = params as { pluginId: string; includeReferences?: boolean };
        const inspected = await catalog.inspect(input.pluginId, input.includeReferences ?? false);
        return jsonResult({
          plugin: serializeRecord(inspected.record),
          requires: inspected.record.manifest.requires ?? [],
          documentation: inspected.documentation,
          references: inspected.references,
        });
      },
    },
    {
      name: "plugin_load",
      label: "Load toolbox plugin",
      description:
        "Load one existing trusted Cordis plugin by id. This never creates code. Newly registered atomic operations become available on the next agent turn.",
      parameters: Type.Object({
        pluginId: Type.String({ minLength: 2 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const input = params as { pluginId: string };
        const record = catalog.get(input.pluginId);
        if (!record) throw new Error(`Unknown plugin: ${input.pluginId}`);
        if (record.source === "project" && !policy.allowProjectPlugins) {
          throw new Error(`Project plugin "${input.pluginId}" is unavailable because the project is not trusted.`);
        }
        const before = new Set(operations.list().map((operation) => operation.name));
        const loaded = await loader.load(input.pluginId, limits.maxPlugins);
        if (!details.loadedPlugins.includes(input.pluginId)) details.loadedPlugins.push(input.pluginId);
        const allNames = refreshTools();
        const added = allNames.filter((name) => !before.has(name));
        return jsonResult(
          {
            loaded: serializeRecord(loaded.record),
            addedOperations: added,
          },
          added,
        );
      },
    },
    {
      name: "runtime_inspect",
      label: "Inspect toolbox runtime",
      description: "List plugins and atomic operations currently loaded in this invocation.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () =>
        jsonResult({
          loadedPlugins: loader.listLoaded().map((item) => item.record.manifest.id),
          operations: operations.list().map((operation) => ({
            name: operation.name,
            description: operation.description,
            risk: operation.risk ?? "read-only",
          })),
          remainingOperationBudget: Math.max(0, limits.maxOperations - details.operationCalls.length),
        }),
    },
  ];
}
