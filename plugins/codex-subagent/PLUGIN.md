# Codex Subagent Plugin

This Cordis plugin connects the toolbox runtime to the local OpenAI Codex CLI (`codex`), allowing the nested agent to delegate heavy coding, codebase analysis, and implementation tasks to an isolated Codex subagent.

## Requirements

Requires the OpenAI Codex CLI (`codex`) installed and on `PATH`, already authenticated. Without it both operations fail at spawn time; the rest of the toolbox is unaffected.

## When to use

- When a task requires deep code exploration, multi-file code analysis, or reviewing changes.
- When an implementation plan needs to be validated or executed by a specialized coding agent.

## Available Operations

### `codex.ask`
- **Risk**: `read-only`
- **Sandbox**: `read-only`
- **Description**: Consult Codex for code analysis, architecture review, or answering complex code questions without modifying any files.
- **Parameters**:
  - `prompt` (string, required): Instructions or question for Codex.
  - `workdir` (string, optional): Target directory relative to workspace root (defaults to `.`).
  - `model` (string, optional): Specific model to request (e.g. `o3-mini`, `deepseek-flash`).

### `codex.execute`
- **Risk**: `write`
- **Sandbox**: `workspace-write`
- **Description**: Instruct Codex to implement, edit, or refactor code in the workspace. Requires `allowWriteOperations: true` in toolbox policy.
- **Parameters**:
  - `prompt` (string, required): Implementation instructions for Codex.
  - `workdir` (string, optional): Target directory relative to workspace root (defaults to `.`).
  - `model` (string, optional): Specific model to request.

## Process & Resource Management

- Codex subagents run as isolated child processes using `--ephemeral --skip-git-repo-check`.
- Cancellation signals (`AbortSignal`) immediately terminate the spawned process and clean up temporary files.
- When the Cordis context is disposed, any active child processes are terminated automatically.
