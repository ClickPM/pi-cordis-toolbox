# Workspace Read

Provides read-only filesystem operations constrained to the active `cwd`.

## Operations

- `workspace.read_file`: read a UTF-8 text file with optional line range.
- `workspace.list_directory`: list direct children of a workspace-relative directory.

The plugin rejects absolute paths, traversal outside `cwd`, and symlink escapes.
