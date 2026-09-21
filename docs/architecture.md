# Architecture

## Call Lifecycle & Dynamic Orchestration

```text
Pi Host Model
  │
  ▼
toolbox_run (Single Fixed Façade)
  │
  ├── 1. Validation & Policy Guard (validate goal, cwd, trust policies)
  ├── 2. Create Ephemeral Cordis Root Context
  ├── 3. TypeSafe Jev (System One) Multi-Dimensional Decision:
  │      └── Produces JevPlan:
  │          ├── executionMode: "deterministic_tools" | "direct_subagent" | "composite"
  │          ├── requiredPlugins: ["checkpoint-rewind", "webfetch", "codex-subagent"]
  │          └── requiresWrite / requiresNetwork / complexity
  │
  ├── 4. Dynamic Cordis Plugin Loading (Filtered by Policy):
  │      ├── Jiti dynamic import on-demand
  │      ├── ctx.plugin(plugin) executes registration
  │      └── Cordis dependency injection (ctx.inject = ["toolbox", "checkpoint", ...])
  │
  ├── 5. Mode-Aware Orchestration:
  │      ├── [deterministic_tools] -> Direct atomic utility call (e.g. tool.diff) (Zero Token, Instant)
  │      ├── [direct_subagent]     -> Standalone subagent execution (e.g. codex.ask, pi.run)
  │      └── [composite]           -> Pipeline with transaction safety:
  │                                   Step 1: checkpoint.create (workspace snapshot)
  │                                   Step 2: web.fetch (fetch external docs with SSRF guard)
  │                                   Step 3: subagent.execute (write code)
  │                                   Step 4: [On Failure] automatic checkpoint.rollback
  │
  └── 6. Reverse Lifecycle Disposal:
         ├── Dispose child plugin Fibers in reverse order
         ├── Cleanup temporary checkpoints & HTTP connection pools
         └── Dispose Cordis root Fiber (Zero residue)
```

## Why Pi sees only one tool

Pi has no public `unregisterTool()` API. Registering temporary atomic tools or external subagents in Pi directly leaves persistent dynamic tool states behind, causing context pollution and schema conflicts. 

The fixed façade `toolbox_run` keeps the entire lifecycle strictly ephemeral and internal to the call-local Cordis microkernel container.

## Plugin Contract & Classification

Plugins are classified into three types:

1. **`utility`**: Pure deterministic computation or tools (e.g., `toolkit-diff`, `webfetch`). Executes locally without additional LLM agent invocation.
2. **`service`**: Middleware services injected into Cordis context (e.g., `checkpoint-rewind` providing `ctx.checkpoint`).
3. **`subagent`**: Specialized external CLI or agent engines (e.g., `codex-subagent`, `pi-subagent`).

### Manifest (`toolbox.plugin.json`)

```json
{
  "id": "toolkit-diff",
  "name": "Toolkit Structured Diff",
  "version": "0.1.0",
  "kind": "utility",
  "capabilities": ["compute diff", "compare files"],
  "entry": "index.ts",
  "risk": "read-only"
}
```

## Security & Transaction Safety

1. **Transaction Rollback**: Tasks requiring file modifications (`requiresWrite: true`) automatically trigger pre-execution snapshots via `checkpoint-rewind`. If a subagent crashes or produces a fatal error, workspace changes are reverted instantly.
2. **SSRF Guard**: The `webfetch` plugin parses target hosts and blocks all private loopback ranges and local cloud VPC subnets.
3. **Path Traversal Protection**: Workspace operations verify path canonicalization via realpath to prevent `../` symlink escapes.
4. **Policy Enforcement**: Permissions (`allowWriteOperations`, `allowNetworkOperations`) are enforced before plugins are imported or operations are executed.
