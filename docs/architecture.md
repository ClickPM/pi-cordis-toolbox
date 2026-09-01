# Architecture

## Call lifecycle

```text
Pi model
  -> toolbox_run (fixed façade)
      -> validate goal / cwd / trust
      -> new Cordis Context
      -> register internal operation services
      -> scan trusted catalog manifests
      -> nested Agent Loop
          -> catalog_search
          -> catalog_inspect
          -> plugin_load
              -> jiti import existing plugin entry
              -> ctx.plugin(plugin)
              -> operation registry gains atomic operations
          -> atomic operation calls
      -> final answer adapter
      -> reverse dispose loaded plugin Fibers
      -> dispose Cordis root Fiber
```

## Why Pi sees only one tool

Pi has no public `unregisterTool()` API. Registering temporary atomic tools in Pi would leave dynamic tool state behind or require unsafe host coupling. The fixed façade keeps the lifecycle entirely within the call-local Cordis context.

## Plugin contract

A plugin directory contains:

- `toolbox.plugin.json`: safe metadata and entrypoint declaration.
- `PLUGIN.md`: human/model-facing details, loaded only during inspection.
- `index.ts` or `index.js`: existing Cordis plugin code, imported only on load.

The entrypoint must export a Cordis plugin. It declares `inject = ["toolbox"]` and registers operations through the internal API. The operation registry validates TypeBox arguments before execution and applies risk policy independently of Pi's outer tool-call hooks.

## Security posture

The MVP deliberately does not support generated code, arbitrary shell, remote package installation, writes, or network operations. Project plugins require Pi project trust. Path-sensitive example plugins realpath both the workspace and target to reject symlink traversal.

Cordis is lifecycle management, not sandboxing. A future untrusted-plugin mode needs a separate process boundary.
