# pi-cordis-toolbox

一个基于 **Cordis 插件微内核** 与 **TypeSafe Jev (System One)** 意图路由的 Pi 异构子代理（Subagent）协作扩展。

Pi 主会话只注册固定入口 `toolbox_run`。每次调用时：
1. **Jev 确定性意图路由**：利用 TypeSafe 旗舰 System One 模型（Jev）在 ~300ms 内对任务进行多维度类型化判定（自主判断最匹配的子代理、是否需要修改工作区文件、任务复杂度）。
2. **Cordis 动态加载与生命周期沙箱**：基于 `@deepseek-ai/cordis` 按需加载对应子代理插件，生命周期结束或任务被取消时通过 Disposer 逆序强制回收子进程，杜绝后台僵尸进程与上下文污染。
3. **专注于异构 Agent**：移除所有非 Agent 的零碎原子工具，核心专注于驱动最擅长特定领域的专业子代理协作。

---

## 内置 Subagent 插件体系

| 子代理插件 | 底层引擎与协议 | 核心能力定位 | 暴露操作 |
| :--- | :--- | :--- | :--- |
| **`codex-subagent`** | OpenAI Codex CLI (`codex exec`) | 重型代码生成、具体实现、Bug 修复、单测编写、深层重构 | `codex.ask` (只读)<br>`codex.execute` (写入) |
| **`cursor-subagent`** | Cursor Agent CLI (`cursor-agent` / `agent`) | 跨文件语义代码搜索、代码库拓扑导航、架构理解、多文件编辑 | `cursor.ask` (只读)<br>`cursor.execute` (写入) |
| **`pi-subagent`** | Pi Coding Agent (`pi -p`) | 通用环境侦察、Markdown 文档撰写、综合调研、终端任务汇总 | `pi.run` (只读)<br>`pi.execute` (写入) |

---

## 目录结构

```text
extensions/toolbox.ts                 # Pi 固定注册入口 (toolbox_run)
src/core/router.ts                    # TypeSafe Jev (System One) 意图裁决路由
src/core/agent-runner.ts              # Cordis 子代理动态调度与结果聚合
src/core/catalog.ts                   # 渐进式插件元数据目录
src/core/plugin-loader.ts             # Jiti 动态导入与 Cordis Fiber 生命周期管理
src/core/operation-registry.ts        # 内部原子操作注册、TypeBox 校验与策略守卫
src/core/runtime.ts                   # Cordis Root Context 运行时与回收
plugins/codex-subagent/               # Codex 专业代码子代理插件
plugins/cursor-subagent/              # Cursor 语义搜索与多文件子代理插件
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

> **注意**：若未配置 `TYPESAFE_API_KEY`，运行时会自动平滑降级至内置的高性能启发式路由，保障离线与私有化场景的可用性。

---

## 开发与自测

```bash
npm install
npm run check
```
