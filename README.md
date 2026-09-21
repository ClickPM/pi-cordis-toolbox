# pi-cordis-toolbox

基于 **Cordis 插件微内核** 与 **TypeSafe Jev (System One)** 拓扑装配决策的 Pi 动态插件装配与即用即抛型沙箱扩展。

Pi 宿主环境只注册固定门面工具 `toolbox_run`。每次调用时：
1. **Jev 组合式意图裁决（Compositional JevPlan）**：利用 TypeSafe 旗舰 System One 模型（Jev）在 ~300ms 内对复杂任务进行多维拓扑裁决，自主推导出所需的插件集合（`requiredPlugins`）、执行模式（纯确定性工具 vs 专用 Agent vs 复合工作流）与写入/网络依赖。
2. **Cordis 微内核即用即抛沙箱**：基于 `@deepseek-ai/cordis` 动态加载所需插件，跨插件通过 Cordis `ctx.inject` 与共享服务（如事务快照）协同工作；任务结束或异常时通过 Disposer 逆序强制回收子进程、清理临时快照与网络连接，杜绝僵尸进程与上下文污染。
3. **摆脱单一 Subagent 局限**：将原子工具（`utility`）、中间件服务（`service`）与专用子代理（`subagent`）平权管理，既支持毫秒级零 Token 的纯本地工具计算，也支持带事务回滚保护的高级代码生成与网络抓取。

---

## 编排执行模式 (Execution Modes)

| 执行模式 | 触发场景 | 典型执行路径 | 消耗与特性 |
| :--- | :--- | :--- | :--- |
| **`deterministic_tools`** | 文件/文本对比、纯数据提取 | 加载 `toolkit-diff`，直接调用 `tool.diff` | **毫秒级极速响应**，零 LLM Token 消耗，不启动任何外部进程 |
| **`direct_subagent`** | 纯代码分析、文档调研、环境探查 | 加载 `codex-subagent` 或 `pi-subagent`，执行只读分析 | 隔离的单代理沙箱执行 |
| **`composite`** | 带文件修改的代码重构、文档抓取并实现 | `checkpoint-rewind` 自动快照 -> `webfetch` 抓取前置文档 -> 注入 Subagent 执行写入 -> **若失败自动触发回滚** | **事务级安全气囊**：任务崩溃自动还原脏改写 |

---

## 内置 Cordis 插件体系

| 插件名称 | 插件类别 | 核心能力定位 | 暴露操作 / 服务方法 | 借鉴开源生态 |
| :--- | :--- | :--- | :--- | :--- |
| **`checkpoint-rewind`** | `service` | 工作区状态快照与事务回滚服务，为写入操作提供安全兜底 | `checkpoint.create`<br>`checkpoint.rollback`<br>`checkpoint.list`<br>`ctx.checkpoint` | `PerryLink/dsh-checkpoint-rewind`<br>`Anionex/dsh-turn-rewind` |
| **`toolkit-diff`** | `utility` | 高性能行级 Unified Diff 与结构化变更统计（零 Token） | `tool.diff` (unified / summary) | `@deepseek-ai/dsh-toolkit`<br>(`dsh-tool-diff`) |
| **`webfetch`** | `utility` | 带 SSRF 安全围栏的轻量网页抓取与 HTML 转 Markdown | `web.fetch` (markdown / json / text) | `dsh-webfetch`<br>`@cordisjs/plugin-http` |
| **`codex-subagent`** | `subagent` | 基于 OpenAI Codex CLI 的高自由度代码编写、Bug 修复与重构 | `codex.ask` (只读)<br>`codex.execute` (写入) | OpenAI Codex CLI |
| **`pi-subagent`** | `subagent` | 基于 Pi Coding Agent 的通用调研、文档编写与终端汇总 | `pi.run` (只读)<br>`pi.execute` (写入) | Pi Coding Agent |

---

## 目录结构

```text
extensions/toolbox.ts                 # Pi 固定注册入口 (toolbox_run)
src/core/router.ts                    # TypeSafe Jev (System One) 多维装配决策
src/core/agent-runner.ts              # Cordis 拓扑编排器与事务回滚守卫
src/core/catalog.ts                   # 插件元数据编目、类型与能力索引
src/core/plugin-loader.ts             # Jiti 动态装配与 Cordis Fiber 生命周期管理
src/core/operation-registry.ts        # 内部原子操作注册、TypeBox 校验与策略守卫
src/core/runtime.ts                   # Cordis Root Context 运行时与回收
plugins/checkpoint-rewind/            # 工作区快照与回滚服务插件
plugins/toolkit-diff/                 # 结构化 Unified Diff 本地原子计算插件
plugins/webfetch/                     # SSRF 防护的轻量网络抓取与清洗插件
plugins/codex-subagent/               # Codex 专业代码子代理插件
plugins/pi-subagent/                  # Pi 通用调研与文档子代理插件
```

---

## 安装与使用

### 1. 从 npm 安装

```bash
pi install npm:pi-cordis-toolbox
```

或本地开发时直接以仓库路径加载：

```bash
pi install /path/to/pi-cordis-toolbox
```

### 2. 配置环境变量

插件优先使用 TypeSafe Jev 模型进行意图裁决。请确保环境中已配置：

```bash
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

> **注意**：若未配置 `TYPESAFE_API_KEY` 或离线环境下，运行时会自动平滑降级至内置的高性能启发式路由器（Heuristic Fallback），保障离线与私有化场景的可用性。

---

## 开发自定义 Cordis 插件

每个插件位于独立目录下，需包含 `toolbox.plugin.json` 与 `index.ts`：

```json
{
  "id": "my-tool",
  "name": "My Custom Tool",
  "version": "0.1.0",
  "kind": "utility",
  "description": "Custom deterministic utility tool",
  "capabilities": ["my_capability"],
  "entry": "index.ts",
  "risk": "read-only"
}
```

```typescript
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";

export default function myToolPlugin(ctx: Context): void {
  ctx.toolbox.registerOperation({
    name: "my.operation",
    label: "My Operation",
    description: "Do something useful",
    risk: "read-only",
    parameters: Type.Object({
      input: Type.String(),
    }),
    execute: async (params, opCtx) => {
      return { content: `Processed: ${params.input}` };
    },
  });
}

myToolPlugin.inject = ["toolbox"];
```

---

## 开发与自测

```bash
npm install
npm run check
```
