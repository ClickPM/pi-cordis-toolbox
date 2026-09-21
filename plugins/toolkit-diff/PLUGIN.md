# Toolkit Diff Plugin

A deterministic, high-performance structured diff utility plugin inspired by `@deepseek-ai/dsh-toolkit` (`dsh-tool-diff`).

## Operations

### `tool.diff`

Computes unified line-by-line diff or change summaries between two files or raw text strings.

#### Parameters

- `source` (string, required): Source file path relative to workspace, or raw source text.
- `target` (string, required): Target file path relative to workspace, or raw target text.
- `isPath` (boolean, optional): Set to `true` to treat inputs as file paths, or `false` for raw strings. If omitted, auto-detects based on file existence.
- `format` (string, optional): `"unified"` (default) or `"summary"`.

#### Example Output (`unified`)

```diff
--- source
+++ target
@@ -1,3 +1,3 @@
-const port = 3000;
+const port = 8080;
 const host = "localhost";
```

#### Example Output (`summary`)

```text
Files comparison:
  Added: 3 lines
  Deleted: 1 lines
  Unchanged: 24 lines
  Total changes: 4 lines
```
