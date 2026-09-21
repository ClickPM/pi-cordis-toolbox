# Cursor Subagent Plugin

This Cordis plugin connects the toolbox runtime to the local Cursor Agent CLI (`cursor-agent` / `agent`), allowing the orchestrator to delegate semantic code exploration, codebase-wide navigation, and multi-file editing to Cursor.

## When to use

- When a task requires codebase-wide semantic search or locating definitions/implementations across many files.
- When an architectural understanding or multi-file refactoring is requested.

## Available Operations

### `cursor.ask`
- **Risk**: `read-only`
- **Mode**: `--mode ask`
- **Description**: Ask Cursor Agent to analyze code, explain architecture, or perform semantic codebase search in read-only mode without file modifications.
- **Parameters**:
  - `prompt` (string, required): Instructions or query for Cursor.
  - `workdir` (string, optional): Target directory relative to workspace root (defaults to `.`).
  - `model` (string, optional): Specific model to request.

### `cursor.execute`
- **Risk**: `write`
- **Mode**: `--yolo`
- **Description**: Instruct Cursor Agent to edit, write, or refactor files across the workspace. Requires `allowWriteOperations: true`.
- **Parameters**:
  - `prompt` (string, required): Implementation instructions for Cursor.
  - `workdir` (string, optional): Target directory relative to workspace root (defaults to `.`).
  - `model` (string, optional): Specific model to request.

## Process & Resource Management

- Runs non-interactively using `--trust -p --output-format text`.
- Abort signals immediately terminate spawned processes.
- All child processes are tracked and cleanly disposed upon Cordis context teardown.
