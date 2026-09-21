# Checkpoint & Rewind Plugin

A transaction safety and rollback service plugin inspired by `PerryLink/dsh-checkpoint-rewind` and `Anionex/dsh-turn-rewind`.

## Concept

Before subagents or tool scripts modify workspace files, a lightweight snapshot is recorded. If an error occurs, or if user requests a reversal, the workspace can be restored to the exact checkpoint state.

Temporary snapshots are automatically cleaned up when the Cordis session disposes.

## Provided Cordis Service

- Service Name: `checkpoint`
- Access via: `ctx.checkpoint.create(cwd, label?)` and `ctx.checkpoint.rollback(checkpointId, cwd)`

## Registered Operations

### `checkpoint.create`

Creates a snapshot of the current workspace state.

- `label` (string, optional): Human-readable description (e.g. "before database refactor").

### `checkpoint.rollback`

Restores the workspace files to a previously saved checkpoint.

- `id` (string, required): Checkpoint ID to restore.

### `checkpoint.list`

Lists all active checkpoints in the current session.
