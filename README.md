# pi-cordis-toolbox

一个独立的 Pi Package / Extension：Pi 只注册固定入口 `toolbox_run`，入口内部创建一次性的 Cordis 运行时，由嵌套 Agent Loop 自主发现、加载并调用已有原子插件。

## 当前实现

- `toolbox_run` 是唯一注册到 Pi 的工具。
- 每次调用创建独立 `@deepseek-ai/cordis` root context。
- 初始只加载元工具：`catalog_search`、`catalog_inspect`、`plugin_load`、`runtime_inspect`。
- 只读取插件 `toolbox.plugin.json` 做搜索；命中后才读取 `PLUGIN.md`；真正 `plugin_load` 时才通过 `jiti` 导入 `index.ts`。
- 插件通过内部 `ctx.toolbox.registerOperation()` 暴露原子操作，不调用 Pi 的 `registerTool()`。
- 每次调用结束、失败或取消，都逆序 dispose 动态插件，再 dispose Cordis root。
- MVP 只加载 `risk: "read-only"` 的包内插件，以及项目受信目录 `.pi/cordis-toolbox/plugins/` 中的插件。
- 不生成、不执行模型产生的新生产代码；不自动下载或安装远程插件；写入和网络操作默认禁止。

## 目录

```text
extensions/toolbox.ts                 # Pi 固定入口
src/core/catalog.ts                   # 渐进式目录发现与文档读取
src/core/plugin-loader.ts             # 受限动态导入与 Fiber 生命周期
src/core/operation-registry.ts        # 内部原子操作注册/校验/策略
src/core/agent-runner.ts              # 嵌套 Agent Loop
plugins/*/toolbox.plugin.json         # 原子插件元数据
plugins/*/PLUGIN.md                   # 按需说明
plugins/*/index.ts                    # 延迟导入的已有插件代码
```

## 使用

从 npm 安装：

```bash
pi install npm:pi-cordis-toolbox
```

或者临时试用，不写入设置：

```bash
pi -e npm:pi-cordis-toolbox
```

本地开发时用仓库路径加载：

```bash
pi install /path/to/pi-cordis-toolbox
```

项目插件放置在：

```text
<project>/.pi/cordis-toolbox/plugins/<plugin-id>/
  toolbox.plugin.json
  PLUGIN.md
  index.ts|index.js
```

只有 Pi 判定当前项目为 trusted 时，项目插件目录才会被扫描。包内插件始终可被扫描，但仍受风险策略限制。

## 开发

当前机器上的 Pi bundled runtime 可直接用于类型检查和测试；安装到 Pi 后，`@earendil-works/pi-*` 与 `typebox` 由宿主提供。

```bash
npm install
npm run check
```

## 已知边界

Cordis 的 `dispose()` 管理 Fiber、服务、监听器和 disposer，但不是 Node 模块卸载机制，也不是安全沙箱。当前包只接受受信任的已有插件；若未来要支持不可信第三方代码，应改为 Worker / 子进程 / Sidecar 隔离，而不是仅依赖 Cordis dispose。
