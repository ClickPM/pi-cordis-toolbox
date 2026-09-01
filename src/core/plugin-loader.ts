import { promises as fs } from "node:fs";
import path from "node:path";
import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import { createJiti } from "jiti";
import type { CatalogRecord, LoadedPlugin } from "./types.ts";
import type { OperationRegistry } from "./operation-registry.ts";
import { PluginCatalog } from "./catalog.ts";

interface PluginModule {
  default?: Plugin;
  plugin?: Plugin;
}

function isSafeRelativePath(rootDir: string, relativePath: string): boolean {
  const resolved = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export class PluginLoader {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly jiti;
  private readonly root: Context;
  private readonly catalog: PluginCatalog;
  private readonly operations: OperationRegistry;

  constructor(root: Context, catalog: PluginCatalog, operations: OperationRegistry) {
    this.root = root;
    this.catalog = catalog;
    this.operations = operations;
    this.jiti = createJiti(import.meta.url, { interopDefault: true });
  }

  listLoaded(): LoadedPlugin[] {
    return [...this.loaded.values()];
  }

  async load(id: string, maxPlugins: number): Promise<LoadedPlugin> {
    const existing = this.loaded.get(id);
    if (existing) return existing;
    if (this.loaded.size >= maxPlugins) {
      throw new Error(`Plugin limit reached (${maxPlugins}).`);
    }
    const record = this.catalog.get(id);
    if (!record) throw new Error(`Unknown plugin: ${id}`);
    if (record.manifest.risk !== "read-only") {
      throw new Error(`Plugin "${id}" is not read-only and is blocked by the MVP policy.`);
    }
    const entryPath = path.resolve(record.rootDir, record.manifest.entry);
    if (!isSafeRelativePath(record.rootDir, record.manifest.entry)) {
      throw new Error(`Plugin entry escapes directory: ${id}`);
    }
    await fs.access(entryPath);
    const module = (await this.jiti.import(entryPath)) as PluginModule;
    const plugin = module.default ?? module.plugin;
    if (typeof plugin !== "function" && (!plugin || typeof plugin !== "object" || typeof plugin.apply !== "function")) {
      throw new TypeError(`Plugin "${id}" does not export a Cordis plugin.`);
    }

    const fiber = this.root.plugin(plugin);
    try {
      await fiber;
    } catch (error) {
      await fiber.dispose().catch(() => undefined);
      throw error;
    }
    const loaded: LoadedPlugin = {
      record,
      fiber,
      operations: this.operations.list().map((operation) => operation.name),
    };
    this.loaded.set(id, loaded);
    return loaded;
  }

  async dispose(): Promise<void> {
    const plugins = [...this.loaded.values()].reverse();
    this.loaded.clear();
    for (const plugin of plugins) {
      await plugin.fiber.dispose();
    }
  }
}

export function serializeRecord(record: CatalogRecord): Record<string, unknown> {
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    keywords: record.manifest.keywords,
    capabilities: record.manifest.capabilities,
    risk: record.manifest.risk ?? "read-only",
    source: record.source,
  };
}
