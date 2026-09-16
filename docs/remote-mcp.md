# 远程 MCP（Streamable HTTP）部署与连接

本地 stdio 保持可用；远程客户端不需要 Node.js 或源码仓库，只需 HTTPS MCP 地址与请求头。
这是 MCP 传输入口，不是 LLM Proxy；不替换用户模型，不开启自动 Hook，不修改腾讯 Core。

## 1. 协议与隔离

- `POST /mcp`：标准 **Streamable HTTP，无状态模式**；每个请求创建独立 MCP 服务与客户端，校验身份。
- 支持 initialize、通知、tools/list、六个工具的 tools/call，使用 JSON 响应。
- 不分配 `Mcp-Session-Id`，不维护共享连接身份；携带该头会被拒绝。
- `GET /mcp` / `DELETE /mcp` 返回 405 是预期行为，不支持旧式 `/sse` 传输。
- `GET /health` 只表示进程健康，不代表 Core/Panel 凭证或连接可用。
- 六个工具：`recall_memory`、`search_memories`、`store_memory`、`wiki_list`、`wiki_search`、`wiki_read_page`。
- 不会自动全量加载记忆或 Wiki；检索默认 limit=5，最大 100。
- L0 会话 ID 使用 backend/实例/团队/Agent/用户/项目/会话标签的哈希命名，防止不同用户传同一标签导致混淆。

## 2. 服务端安装（Ubuntu）

需要 Git、Node.js（推荐与你已验证的 Node 24 保持一致），以及访问仓库的 SSH 权限。
以下命令从你选择的父目录执行；已 clone 时直接进入现有仓库，不重新覆盖。

```bash
git clone git@github.com:1206395410/TencentAgentMemoryBridge.git
```

```bash
cd TencentAgentMemoryBridge
```

```bash
npx --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge install --frozen-lockfile
```

```bash
npx --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge build
```

```bash
npx --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge test
```

```bash
npx --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge test:stdio
```

维护者必须先提交并推送远程功能，服务器 clone 才能获取。本文不表示代码已经推送或服务器已经部署。

## 3. 配置后台与授权范围

复制模板（`-n` 防止覆盖已有配置）：

```bash
cp -n examples/remote-mcp/policy.example.json remote-policy.json
```

```bash
chmod 600 remote-policy.json
```

生成 Core 网关凭证的 SHA-256。下面是一段需要整体执行的脚本，不回显密钥、不把真实值放进命令历史：

```bash
read -r -s -p '请输入 Memory Core 网关凭证：' MEMORY_GATEWAY_KEY
printf '\n'
printf '%s' "$MEMORY_GATEWAY_KEY" | sha256sum
unset MEMORY_GATEWAY_KEY
```

将输出的 **64 位十六进制摘要** 填入 `apiKeySha256`；客户端仍使用原始凭证，不是这个摘要。

```bash
nano remote-policy.json
```

必须修改：

| 字段 | 用途 |
|---|---|
| `allowedHosts` | 客户端实际访问的精确 host[:port]，如域名或 `127.0.0.1:8430`，不支持通配符 |
| `allowedOrigins` | 默认 `[]`，拒绝所有带 Origin 的跨源请求；原生客户端无 Origin 不受此限制。如客户端发送 Origin，填它的可信 HTTPS Origin |
| `backends[].memoryEndpoint` | Bridge 服务器能够访问的 Core 地址，只能是 HTTP(S) origin |
| `backends[].panelEndpoint` | Bridge 服务器能够访问的 Panel 地址；接受 origin 或 `/api/v1` 后缀 |
| `backends[].serviceId` | Core 实例，如 `default` |
| `backends[].apiKeySha256` | 允许的网关凭证摘要，可填多个用于轮换 |
| `grants[]` | 管理员显式允许的 backend/team/user/agent/task 组合，无隐式通配授权 |

你现有部署若在同一台 Ubuntu 主机且已映射 8420/8125，可使用模板中的 `127.0.0.1`。若 Bridge 放进独立容器，127.0.0.1 指该容器自己，需要填写 Docker 网络中的服务名等实际地址。

授权项示例（所有 ID 应在 Memory 中真实存在）：

```json
{
  "backend": "main",
  "teamId": "team-your-team",
  "agentId": "agt-your-agent",
  "userId": "usr-your-user",
  "taskIds": ["tm", "sfa"]
}
```

每位用户增加自己的 grants。授权表示允许该组合的记忆读写；不是只读授权。
Core 网关凭证可能是共享凭证，**不是个人身份**：每次请求还会调用 Panel 的 `/meta/auth/verify` 验证 USER_KEY 对应 USER_ID，以及 `/meta/team-member/get` 验证 active 成员。
Agent/项目授权使用上述管理员 grants（不是假设团队成员能访问所有 Agent）；管理员撤销或调整 Agent/项目授权时必须同步修改 grants 并重启 Bridge。
Wiki 仍经 Panel 对每个资产执行已有 ACL 校验。Panel 不可达或身份校验失败会拒绝请求，不绕过鉴权。

该文件启动时加载，修改后需要重启。不要提交个人部署配置或原始凭证到 Git。

## 4. 启动与 HTTPS

在仓库根目录执行：

```bash
export MCP_REMOTE_CONFIG="$PWD/remote-policy.json"
```

```bash
node packages/mcp-bridge/dist/http.js
```

默认只监听 `127.0.0.1:8430`。另开终端检查：

```bash
curl -fsS http://127.0.0.1:8430/health
```

可选环境变量：`MCP_HTTP_HOST`、`MCP_HTTP_PORT`。不读取客户端的远程进程环境变量来确定个人身份，也不从服务器 cwd 派生项目。

正式使用应由 Nginx/Caddy 提供 HTTPS，只对公网开放 443，后端 8430 保持本机可达。Nginx 已配置域名和 TLS 证书的 server 块内可添加：

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8430;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_read_timeout 60s;
    client_max_body_size 1m;
}
```

这是 location 示例，不是完整 TLS 配置；需要你的真实域名和证书。自定义 X-Memory 请求头通常由 Nginx 原样转发，不要剥离它们。
在反向代理增加限流；应用最多同时处理 32 个 MCP 请求，正文限制 1 MiB。不要记录 Authorization、X-Memory-User-Key 或请求正文。
公网不可使用明文 HTTP 携带凭证；CORS 只接受明确列出的 Origin，不能配置 `*`。
用 systemd/现有进程管理器常驻时，应使用专用普通用户，指定真实 Node 路径、仓库工作目录和 `MCP_REMOTE_CONFIG` 绝对路径。

## 5. 客户端请求头

| 请求头 | 对应旧配置 | 必填 |
|---|---|---|
| `Authorization: Bearer ...` | API_KEY | 是；网关凭证 |
| `X-Memory-User-Key` | USER_KEY | 可省略；省略时复用 API_KEY，但仍必须通过个人身份校验 |
| `X-Memory-Service-Id` | SERVICE_ID | 是 |
| `X-Memory-Team-Id` | TEAM_ID | 是 |
| `X-Memory-Agent-Id` | AGENT_ID | 是 |
| `X-Memory-User-Id` | USER_ID | 是 |
| `X-Memory-Task-Id` | TASK_ID | 是；如 `tm`，使用英文/数字/下划线/点/短横线，最长100字符 |
| `X-Memory-Session-Key` | SESSION_KEY | 否；默认按 UTC 日期分组，可明确指定会话标签 |
| `X-Memory-Endpoint`、`X-Memory-Panel-Endpoint` | MEMORY_ENDPOINT、PANEL_ENDPOINT | 否；必须同时提供，且整个地址对与实例必须精确匹配服务器 backends 白名单 |

这些头需要在每次 MCP 请求中发送，不是只在 initialize 时发送。不把身份和密钥作为工具参数或 URL 查询参数传递。
远程必填 TASK_ID，否则 400；如果想接续之前 `task_id=down` 的 L1 范围，需要请求填 `down`，且管理员把它列入 grants。换成 `tm` 不会自动搬迁旧记忆。

## 6. Claude Code

将 `examples/remote-mcp/claude.example.json` 合并到用户配置 `.claude.json` 的已有 `mcpServers` 中，不覆盖其他服务。
替换域名、网关凭证、个人凭证和实际 ID。这里 `type=http` 表示 Streamable HTTP。
不再配置 command/args 或 Node 路径。没有 GUI JSON 编辑器时，也可以使用 Claude 自带 `mcp add --transport http`，各请求头需按该版本 CLI 的 `--header` 参数配置。

保存后重启 Claude 会话，检查 `/mcp`，先验证只读工具：

```text
请调用 tencentDB-Agent-Memory-remote 的 search_memories 搜索“宴席奖励”，limit=5。
只查询，不写入，展示结果及 _context，不展示任何凭证。
```

确认 `_context` 的 user/team/agent/task 正确后，再按需验证 store_memory。验证成功后停用旧的本地同类 MCP，避免模型看见两组工具。
远程 MCP 不会让 Claude 自动每轮查询或保存；自动化策略需另行配置。

## 7. Multica

需要该版本客户端支持 **Streamable HTTP 和自定义请求头**：

- 名称：`tencentDB-Agent-Memory-remote`
- Transport：Streamable HTTP（不是旧式 SSE）
- URL：`https://你的域名/mcp`
- Headers：复制 `examples/remote-mcp/multica-headers.example.json`，替换所有占位信息。

Headers 示例只是请求头对象，**不是 Multica 完整服务 JSON**；此前仅验证过你的本地 command/args 配置，远程表单字段和导入格式仍需按实际版本确认。不虚构 Multica 完整 JSON schema。
请求可能来自桌面执行端，也可能来自自托管后端，实际执行端必须能访问该 HTTPS 地址。客户端不支持自定义头时，本方案不能仅靠 URL 接入，需要升级客户端或另行实现兼容认证。

## 8. 故障与测试

- 400：缺少/非法身份或项目、重复头、未知 X-Memory 头、试图携带 MCP 会话 ID。
- 401：网关凭证缺失或摘要不匹配（轮换后需要同时更新 policy）。
- 403：用户不匹配、成员不活跃、grants 未授权、Host/Origin 或上游地址不允许。
- 405：GET/DELETE 到 `/mcp`；无状态模式的预期响应，不表示 POST 工具调用失败。
- 413：请求正文超过 1 MiB。
- 429：并发请求过多；稍后重试。
- 503：Panel 鉴权服务不可用、非预期响应或拒绝跳转；不降级绕过鉴权。
- 工具 `isError`：参数、Core/Panel 权限或业务错误；远程错误隐藏上游原文，避免泄露密钥。

测试只使用本地模拟 Core/Panel，不调用真实模型，也不向生产记忆写入。覆盖六个工具、两用户并发、相同会话标签隔离、伪造身份、越权、地址白名单、禁止跳转、Host/Origin、载荷与参数限制。本地 stdio 另有 smoke 测试。

## 9. 安全边界

这是请求头凭证模式，不是 OAuth 登录产品。管理员维护 grants，个人 USER_KEY 用于实时身份验证。
Policy 中保存的网关摘要只能用于比对；用户凭证不会写入文件或日志。但管理员仍应按敏感配置保护 policy。
相同用户在不同客户端使用同一身份及 taskId 时可访问同一范围；不同用户是否共享由 Core/Panel 数据与权限规则决定，不通过修改 USER_ID 冒充他人。
此服务只加固远程 Bridge，不会自动收紧现有公网 Core/Panel：应通过网络规则限制 Core 网关仅被受信任的服务访问，否则持有共享网关密钥的人仍可能绕过 Bridge。
