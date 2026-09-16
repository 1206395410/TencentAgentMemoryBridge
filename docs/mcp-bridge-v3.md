# mcp-bridge v3 使用指南

> **版本**: 0.4.0 · 面向团队版（MemoryCore `/v3/*`）
> **状态**: 全量重写完成，直连 MemoryCore Gateway，不再依赖 bridge-server

## 概述

mcp-bridge v3 是 MCP（Model Context Protocol）服务器，把 AI Agent 的记忆工具调用**直连**到 MemoryCore Gateway（团队版 `/v3/*` 数据面）。相比 v0.2：

- ❌ 移除 bridge-server 中转（已退役）
- ❌ 移除 sender 隔离（改为 v3 隔离三元组 team/agent/user）
- ❌ 移除 `end_session` 工具（v3 无对应端点，session 只是客户端 key）
- ✅ 新增多层级召回（`recall_memory` 合并 L1 事实 + L3 persona + L2 场景索引）
- ✅ 0.4.0：task_id 防混用校验（拒绝身份前缀）+ 工具结果 `_context` 回显隔离域

## 配置

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MEMORY_ENDPOINT` | ✅ | MemoryCore Gateway 地址（如 `https://memory.kuai-private.top`） |
| `API_KEY` | ✅ | 网关门禁 key（`Authorization: Bearer`，多 agent 共用） |
| `SERVICE_ID` | ✅ | memory 实例 id / spaceId（`x-tdai-service-id`） |
| `TEAM_ID` | ✅ | v3 隔离：团队 id |
| `AGENT_ID` | ✅ | v3 隔离：agent id（每平台一个） |
| `USER_ID` | ✅ | v3 隔离：user id |
| `USER_KEY` | ❌ | 该 agent 的 user_key（meta 面鉴权用，可选） |
| `TASK_ID` | ❌ | task_id（项目级隔离标签）；未设则**自动从项目路径派生**（cwd 目录名）；**拒绝身份前缀 `agt-`/`team-`/`usr-`/`sk-`（≥0.4.0）** |
| `SESSION_KEY` | ❌ | 默认 session key；缺省自动生成 `<AGENT_ID>-<YYYY-MM-DD>` |
| `TIMEOUT_MS` | ❌ | 请求超时（毫秒，默认 15000） |

完整占位符示例见 [`packages/mcp-bridge/.env.example`](../packages/mcp-bridge/.env.example)。

### MCP settings.json 示例（Claude Code / CodeBuddy）

从 `git@github.com:1206395410/TencentAgentMemoryBridge.git` 克隆并构建；
完整命令见 [源码克隆部署步骤](wiki-readonly-mcp.md#windows-构建与验证)。
启动入口是实际 clone 目录下的 `packages/mcp-bridge/dist/index.js`，不是 npm 发布版。
构建后，在 clone 的仓库根目录执行以下 PowerShell，自动生成当前机器的 JSON 配置，
无需写死 Node 或仓库位置。输出中的身份和凭证仍是占位符，使用前需填入自己的实际值：

```powershell
$BridgeRepo = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $BridgeRepo "packages\mcp-bridge\package.json"))) {
    throw "请在 clone 的 TencentAgentMemoryBridge 仓库根目录执行（不是 packages 等子目录）"
}
$NodeExe = (Get-Command node.exe).Source
$BridgeEntry = (Resolve-Path -LiteralPath (Join-Path $BridgeRepo "packages\mcp-bridge\dist\index.js")).Path
@{
  mcpServers = @{
    'agent-memory' = @{
      command = $NodeExe
      args = @($BridgeEntry)
      env = @{
        MEMORY_ENDPOINT = 'http://129.211.92.200:8420'
        PANEL_ENDPOINT = 'http://129.211.92.200:8125'
        API_KEY = '<gate-api-key>'
        SERVICE_ID = 'default'
        TEAM_ID = '<team-id>'
        AGENT_ID = '<agent-id>'
        USER_ID = '<user-id>'
      }
    }
  }
} | ConvertTo-Json -Depth 5
```

> ⚠️ 不要填真实 key 到仓库文件；通过本机 `.env`（已被 `.gitignore` 排除）或 MCP settings 的 env 字段注入。

### task_id（项目级隔离，与身份严格分离）

mcp-bridge 支持 **task_id** 做项目级区分：

- **显式设置**：`TASK_ID=<project-name>` 环境变量
- **自动派生**：未设时读 `process.cwd()`（客户端启动 MCP 时的项目目录）取目录名，如 `TencentAgentMemoryBridge`
- **防混用（≥0.4.0）**：启动时校验，`agt-` / `team-` / `usr-` / `uky-` / `sk-` / `key-` 前缀的 `task_id` 直接报错拒绝——**`task_id` 是项目级标签，不是身份 id**。绝不能把 `AGENT_ID`（`agt-*`）/ `TEAM_ID`（`team-*`）/ `USER_ID`（`usr-*`）/ key 填进 `TASK_ID`（否则所有项目共享同一个"task"，项目级隔离失效）

写入（`conversation/add`）和召回（`atomic/search`）都会带 `task_id`：

- **L1 事实按项目隔离**（项目 A 的事实不进项目 B 的召回）
- **L3 persona / L2 场景仍跨项目共享**（按 team+agent 维度）

> 工具结果（≥0.4.0）带 `_context` 回显 `{team_id, agent_id, user_id, task_id}`，调用方可确认当前隔离域，避免 agent/task 混用。

## 工具

### 可选 Wiki 只读扩展（源码版）

设置 `PANEL_ENDPOINT` 后（`USER_KEY` 未填时复用 `API_KEY`，仍校验用户身份），额外启用 `wiki_list`、`wiki_search`、
`wiki_read_page`。通过 Panel 8125 的用户鉴权/ACL接口访问 Wiki，不直连无用户鉴权的
Knowledge 8424。未配置时原有三个工具不变。
完整构建、客户端配置、权限和测试说明见 [Wiki 只读扩展](wiki-readonly-mcp.md)。

### 原有记忆工具

| 工具 | 映射到 v3 | 说明 |
| --- | --- | --- |
| `recall_memory(query, limit?, include_persona?, include_scenes?)` | `/v3/atomic/search` + `/v3/core/read` + `/v3/scenario/ls` | 多层级召回，返回 `{facts, persona?, scenes?, _context}` |
| `store_memory(user_content, assistant_content, session_key?)` | `/v3/conversation/add` | 写 L0，必填 session；返回 `{accepted_ids, _context}` |
| `search_memories(query, limit?, type?)` | `/v3/atomic/search` | L1 语义搜索，返回 `{items, _context}` |

> 工具不接受 `agent_id` / `task_id` 参数——身份与项目标签由 MCP env 注入，模型无需（也不应）猜测或混用。

## 本地测试

```bash
cd packages/mcp-bridge
# 配置真实 key 到本机 .env（勿提交）
pnpm build
pnpm test
```

## 安全

- 真实 key 只放本机 `.env` / 环境变量，`/f/Project/TencentAgentMemoryBridge/.gitignore` 已排除 `.env`
- 网关门禁 `API_KEY` 多 agent 共用；agent 身份由 `AGENT_ID` + `USER_ID` 区分
- 数据面写入需隔离三元组；测试时用独立 `spaceId`（如 test-space-002）避免污染生产
