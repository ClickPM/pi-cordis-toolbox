import { promises as fs } from "node:fs";
import path from "node:path";
import type { CatalogRecord, PluginKind, PluginManifest } from "./types.ts";

const MANIFEST_NAME = "toolbox.plugin.json";
const SAFE_ID = /^[a-z][a-z0-9-]{1,80}$/;

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathIfExists(input: string): Promise<string | undefined> {
  try {
    return await fs.realpath(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Manifest field "${field}" must be a string array.`);
  }
  return value;
}

function parseManifest(value: unknown, manifestPath: string): PluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid plugin manifest: ${manifestPath}`);
  }
  const raw = value as Record<string, unknown>;
  for (const key of ["id", "name", "version", "description", "entry"]) {
    if (typeof raw[key] !== "string" || !raw[key]) {
      throw new TypeError(`Manifest field "${key}" must be a non-empty string: ${manifestPath}`);
    }
  }
  if (!SAFE_ID.test(raw.id as string)) {
    throw new TypeError(`Invalid plugin id "${raw.id}" in ${manifestPath}`);
  }
  const risk = raw.risk ?? "read-only";
  if (!["read-only", "write", "network", "unsafe"].includes(risk as string)) {
    throw new TypeError(`Invalid plugin risk "${String(risk)}" in ${manifestPath}`);
  }
  const validKinds: PluginKind[] = ["utility", "service", "subagent"];
  let kind = raw.kind as PluginKind | undefined;
  if (kind !== undefined && !validKinds.includes(kind)) {
    throw new TypeError(`Invalid plugin kind "${String(kind)}" in ${manifestPath}`);
  }
  if (!kind) {
    const id = raw.id as string;
    const keywords = Array.isArray(raw.keywords) ? (raw.keywords as string[]) : [];
    if (id.endsWith("-subagent") || keywords.includes("subagent")) {
      kind = "subagent";
    } else {
      kind = "utility";
    }
  }
  const provides = raw.provides === undefined ? undefined : parseStringArray(raw.provides, "provides");

  return {
    id: raw.id as string,
    name: raw.name as string,
    version: raw.version as string,
    description: raw.description as string,
    entry: raw.entry as string,
    keywords: parseStringArray(raw.keywords ?? [], "keywords"),
    capabilities: parseStringArray(raw.capabilities ?? [], "capabilities"),
    readme: typeof raw.readme === "string" ? raw.readme : undefined,
    references: raw.references === undefined ? undefined : parseStringArray(raw.references, "references"),
    risk: risk as PluginManifest["risk"],
    requires: raw.requires === undefined ? undefined : parseStringArray(raw.requires, "requires"),
    kind,
    provides,
  };
}

async function scanRoot(rootDir: string, source: CatalogRecord["source"]): Promise<CatalogRecord[]> {
  const rootReal = await realpathIfExists(rootDir);
  if (!rootReal) return [];
  const entries = await fs.readdir(rootReal, { withFileTypes: true });
  const records: CatalogRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const pluginDir = path.join(rootReal, entry.name);
    const manifestPath = path.join(pluginDir, MANIFEST_NAME);
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const manifest = parseManifest(JSON.parse(raw), manifestPath);
    const entryPath = path.resolve(pluginDir, manifest.entry);
    if (!isInside(pluginDir, entryPath)) {
      throw new Error(`Plugin entry escapes its directory: ${manifest.id}`);
    }
    records.push({ manifest, rootDir: pluginDir, source });
  }
  return records;
}

export class PluginCatalog {
  private readonly records = new Map<string, CatalogRecord>();
  private readonly packageRoot: string;
  private readonly cwd: string;
  private readonly allowProjectPlugins: boolean;

  constructor(packageRoot: string, cwd: string, allowProjectPlugins: boolean) {
    this.packageRoot = packageRoot;
    this.cwd = cwd;
    this.allowProjectPlugins = allowProjectPlugins;
  }

  async refresh(): Promise<CatalogRecord[]> {
    this.records.clear();
    const packageRecords = await scanRoot(path.join(this.packageRoot, "plugins"), "package");
    const projectRecords = this.allowProjectPlugins
      ? await scanRoot(path.join(this.cwd, ".pi", "cordis-toolbox", "plugins"), "project")
      : [];

    for (const record of [...packageRecords, ...projectRecords]) {
      const existing = this.records.get(record.manifest.id);
      if (existing) {
        throw new Error(
          `Duplicate plugin id "${record.manifest.id}" from ${existing.rootDir} and ${record.rootDir}`,
        );
      }
      this.records.set(record.manifest.id, record);
    }
    return this.list();
  }

  list(): CatalogRecord[] {
    return [...this.records.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  get(id: string): CatalogRecord | undefined {
    return this.records.get(id);
  }

  listByKind(kind: PluginKind): CatalogRecord[] {
    return this.list().filter((record) => record.manifest.kind === kind);
  }

  listByCapability(capability: string): CatalogRecord[] {
    const target = capability.toLowerCase();
    return this.list().filter((record) =>
      record.manifest.capabilities.some(
        (c) => c.toLowerCase() === target || c.toLowerCase().includes(target),
      ),
    );
  }

  getService(serviceName: string): CatalogRecord | undefined {
    return this.list().find(
      (record) =>
        record.manifest.kind === "service" && record.manifest.provides?.includes(serviceName),
    );
  }

  search(query: string, limit = 8): CatalogRecord[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_.-]+/u)
      .filter(Boolean);
    if (!terms.length) return this.list().slice(0, limit);

    return this.list()
      .map((record) => {
        const manifest = record.manifest;
        const fields = {
          id: manifest.id.toLowerCase(),
          name: manifest.name.toLowerCase(),
          description: manifest.description.toLowerCase(),
          keywords: manifest.keywords.join(" ").toLowerCase(),
          capabilities: manifest.capabilities.join(" ").toLowerCase(),
        };
        const score = terms.reduce((total, term) => {
          if (fields.id === term) return total + 20;
          if (fields.id.includes(term)) return total + 10;
          if (fields.name.includes(term)) return total + 8;
          if (fields.capabilities.includes(term)) return total + 6;
          if (fields.keywords.includes(term)) return total + 4;
          if (fields.description.includes(term)) return total + 2;
          return total;
        }, 0);
        return { record, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.record.manifest.id.localeCompare(b.record.manifest.id))
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map((item) => item.record);
  }

  async inspect(id: string, includeReferences = false): Promise<{
    record: CatalogRecord;
    documentation?: string;
    references?: Record<string, string>;
  }> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown plugin: ${id}`);
    const result: {
      record: CatalogRecord;
      documentation?: string;
      references?: Record<string, string>;
    } = { record };

    if (record.manifest.readme) {
      const readmePath = path.resolve(record.rootDir, record.manifest.readme);
      if (!isInside(record.rootDir, readmePath)) throw new Error(`Plugin readme escapes directory: ${id}`);
      result.documentation = await fs.readFile(readmePath, "utf8");
    }

    if (includeReferences && record.manifest.references?.length) {
      result.references = {};
      for (const relative of record.manifest.references) {
        const referencePath = path.resolve(record.rootDir, relative);
        if (!isInside(record.rootDir, referencePath)) {
          throw new Error(`Plugin reference escapes directory: ${id}`);
        }
        result.references[relative] = await fs.readFile(referencePath, "utf8");
      }
    }
    return result;
  }
}
