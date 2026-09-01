import { Context } from "@deepseek-ai/cordis";
import type { ToolboxOperationDefinition, ToolboxPluginApi } from "./types.ts";
import type { OperationRegistry } from "./operation-registry.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    toolboxOperations: OperationRegistry;
    toolbox: ToolboxPluginApi;
  }
}

export function toolboxApiPlugin(ctx: Context): void {
  const registry = ctx.get("toolboxOperations") as OperationRegistry | undefined;
  if (!registry) throw new Error("toolboxOperations service is unavailable");

  const api: ToolboxPluginApi = {
    registerOperation(operation: ToolboxOperationDefinition): void {
      throw new Error(`Unbound toolbox API attempted to register ${operation.name}`);
    },
  };
  Object.defineProperty(api, Symbol.for("cordis.tracker"), {
    value: { property: "ctx" },
  });
  Object.defineProperty(api, "ctx", {
    value: ctx,
    writable: true,
  });
  api.registerOperation = function (operation: ToolboxOperationDefinition): void {
    const caller = (this as ToolboxPluginApi & { ctx: Context }).ctx;
    const dispose = registry.register(operation);
    caller.effect(() => dispose, `operation:${operation.name}`);
  };

  ctx.provide("toolbox", api);
}
toolboxApiPlugin.inject = ["toolboxOperations"];
toolboxApiPlugin.provide = "toolbox";
