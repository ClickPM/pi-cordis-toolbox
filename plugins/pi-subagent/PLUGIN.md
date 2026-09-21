# Pi Subagent Plugin

This Cordis plugin connects the toolbox runtime to an isolated Pi process (`pi`), allowing the orchestrator to delegate general codebase reconnaissance, markdown documentation, research, and terminal workflows to Pi.

## When to use

- When a task involves high-level research, documentation, summarization, or general tool invocation.
- When general reconnaissance is needed without modifying production code.

## Available Operations

### `pi.run`
- **Risk**: `read-only`
- **Description**: Delegate a general investigation, documentation, or summarization task to an isolated Pi subagent in read-only mode.
- **Parameters**:
  - `prompt` (string, required): Task instructions for the Pi subagent.
  - `workdir` (string, optional): Target directory relative to workspace root (defaults to `.`).
  - `model` (string, optional): Optional model override for Pi.

### `pi.execute`
- **Risk**: `write`
- **Description**: Instruct Pi subagent to perform tasks that may create or modify files. Requires `allowWriteOperations: true`.
- **Parameters**:
  - `prompt` (string, required): Task instructions for the Pi subagent.
  - `workdir` (string, optional): Target directory relative to workspace root (defaults to `.`).
  - `model` (string, optional): Optional model override for Pi.

## Process & Resource Management

- Runs non-interactively via `pi -p --session-dir <tempDir> --mode text`.
- Abort signals immediately terminate spawned subagent processes.
- Disposers clean up child processes and temporary session directories upon Cordis teardown.
