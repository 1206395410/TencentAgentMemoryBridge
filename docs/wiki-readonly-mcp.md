# 源码版 MCP：读取 Wiki 知识库

## 功能与边界

新增 `wiki_list`、`wiki_search`、`wiki_read_page` 三个只读工具。原来的
`recall_memory`、`store_memory`、`search_memories` 不变。
不上传、写入、删除、触发 Ingest，不调用模型，也不需要模型 API Key。
Wiki 抽取需要在管理面板单独完成；工具不会修复模型渠道故障。

**重要修正：不要直接将用户查询接到公网 8424。** 核对官方版本
`0468a2a5b50eaafc54758ed1e2e6609472e5b6ce` 后发现，Knowledge 原始 Wiki
路由按 service_id 寻址，没有用户鉴权中间件；用户身份、团队和资产 ACL
检查在 Panel 中。因此本实现仅访问 Panel 的 `/api/v1/*`，不会在鉴权失败时
回退到原始 Knowledge 接口，也不需要新的远程 MCP 服务。

## 配置

保留当前 MCP 配置的所有 Memory Core 环境变量，新增：

```json
{
  "PANEL_ENDPOINT": "http://129.211.92.200:8125"
}
```

这是放入现有 `env` 对象的一项，不是替换整个 MCP 配置。按当前部署需求，
未填写 USER_KEY 时复用现有 API_KEY，但每次调用仍向 Panel 验证该 Key 的用户身份。
若网关和用户凭证不同，请额外配置 `USER_KEY`，其优先级高于 API_KEY。

- `PANEL_ENDPOINT`：Panel 根地址，或以 `/api/v1` 结尾的地址；不填时不注册 Wiki 工具。
- `USER_KEY`：可选的独立 Memory 用户凭证，通过 `x-tdai-user-key` 发送，必须与 `USER_ID` 匹配。
  不是模型 Key；未填时使用 API_KEY，不代表所有网关凭证都天然拥有用户权限。
- `SERVICE_ID`、`TEAM_ID`、`USER_ID`：复用现有配置，不接受模型通过工具参数覆盖。
- `TIMEOUT_MS`：沿用现有请求超时，默认 15000；Wiki 模式接受 1～300000 毫秒。
- Wiki 按用户权限和配置的团队访问，不按 `AGENT_ID`、`TASK_ID` 或 session 限制。
  工具结果 `_context` 只回显 service/team/user，不回显凭证。
- 当前代码不会自动加载 `.env`；使用客户端 MCP `env` 配置，或显式注入环境变量。

公网 HTTP 会明文传输凭证和文档内容；正式团队部署应使用 HTTPS 或可信内网。
应使用个人用户凭证，不要给所有成员共享管理员凭证。此客户端的参数校验不替代
服务端权限控制；原始 8424 应在部署层限制访问。

## Windows 构建与验证

### 1. 克隆源码

使用 Git、Node.js 24 和 PowerShell。GitHub 账号需具有该仓库访问权限，并已配置 SSH Key。
部署源统一为 `git@github.com:1206395410/TencentAgentMemoryBridge.git`，不再安装 npm 发布版。
维护者需先将 Wiki 扩展提交并推送到要部署的分支；仅存在于本地的修改不会被其他人 clone 到。

首次安装：在你希望存放源码的位置打开 PowerShell，执行以下命令，不限定磁盘或父目录。

```powershell
git clone git@github.com:1206395410/TencentAgentMemoryBridge.git
cd TencentAgentMemoryBridge
```

如果已经 clone，跳过上述命令，在现有仓库中打开 PowerShell 即可。
随后在仓库根目录执行（包含 packages、package.json 的目录，不是子目录）。
使用 PowerShell 自身获取路径，不读取 Git 的路径输出，避免 Windows PowerShell 的中文解码问题：

```powershell
$BridgeRepo = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $BridgeRepo "packages\mcp-bridge\package.json"))) {
    throw "请在 clone 的 TencentAgentMemoryBridge 仓库根目录执行（不是 packages 等子目录）"
}
Set-Location -LiteralPath $BridgeRepo
git remote -v
```

remote 应指向指定仓库，不要删除现有目录重新克隆。

### 2. 构建与测试

在上述仓库根目录、同一个 PowerShell 窗口执行：

```powershell
npx.cmd --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge install --frozen-lockfile
npx.cmd --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge build
npx.cmd --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge test
npx.cmd --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge test:stdio
```

单元测试 mock HTTP；`test:stdio` 启动真实编译后的 MCP 进程及本地假 Panel/Core，
测试三个工具的串联与权限拒绝，不连接生产、不使用真实凭证、不写生产数据。
运行 stdio 测试前必须先 build。

### 3. 从 clone 路径生成 MCP 启动路径

```powershell
$BridgeRepo = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $BridgeRepo "packages\mcp-bridge\package.json"))) {
    throw "请在 clone 的 TencentAgentMemoryBridge 仓库根目录执行（不是 packages 等子目录）"
}
$NodeExe = (Get-Command node.exe).Source
$BridgeEntry = (Resolve-Path -LiteralPath (Join-Path $BridgeRepo "packages\mcp-bridge\dist\index.js")).Path
Test-Path $NodeExe
Test-Path $BridgeEntry
```

两项检查都应为 True。MCP 直接启动 **clone 目录下的编译产物**，不是仓库根目录本身，
也不是旧的 `node_modules\tencent-agent-memory-mcp-bridge\dist\index.js`。
可以输出一个不含凭证的启动配置，路径会自动按 JSON 规则转义：

```powershell
@{ command = $NodeExe; args = @($BridgeEntry) } | ConvertTo-Json -Depth 3
```

将上面输出的 JSON 合并到客户端对应 MCP 项中。它包含自动获取的 Node 和实际 clone 路径，
无需手写本机目录。JSON 中使用的是解析后的绝对路径，不是字面量 `$BridgeEntry`；
注册完成后可从任意业务项目使用 MCP，不必始终在 Bridge 仓库中打开客户端。

保留原有 `env` 并添加 PANEL_ENDPOINT（必要时另填 USER_KEY），重连 MCP。Multica 需要选中这台 Windows
执行端；如果运行在别的机器，这个入口路径不能直接使用。

### 4. 后续更新

先退出使用该 MCP 的会话。在仓库根目录执行 `git status --short`，有未提交修改时先妥善
提交或保存，不要 reset/覆盖。确认工作区干净且分支正确后：

```powershell
$BridgeRepo = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $BridgeRepo "packages\mcp-bridge\package.json"))) {
    throw "请在 clone 的 TencentAgentMemoryBridge 仓库根目录执行（不是 packages 等子目录）"
}
Set-Location -LiteralPath $BridgeRepo
git pull --ff-only
npx.cmd --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge install --frozen-lockfile
npx.cmd --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge build
npx.cmd --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge test
npx.cmd --yes pnpm@11.7.0 --filter tencent-agent-memory-mcp-bridge test:stdio
```

重连客户端即可；clone 目录不变就不需要重新注册路径。移动或删除 clone 目录会影响 MCP 启动。

## Multica 配置

在 Multica 的“添加 MCP Server”或现有 MCP 编辑窗口中，选择 **JSON**。
这里接收的是单个服务对象：最外层直接是 `command`、`args`、`env`，
**不要套 Claude Code 的 `mcpServers` 或服务名外层**。

### 从当前 clone 仓库生成配置

先按前文完成 build，然后在 clone 的仓库根目录打开 PowerShell，执行：

```powershell
$BridgeRepo = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $BridgeRepo "packages\mcp-bridge\package.json"))) {
    throw "请在 clone 的 TencentAgentMemoryBridge 仓库根目录执行（不是 packages 等子目录）"
}
$NodeExe = (Get-Command node.exe).Source
$BridgeEntry = (Resolve-Path -LiteralPath (Join-Path $BridgeRepo "packages\mcp-bridge\dist\index.js")).Path

$MemorySecret = Read-Host "请输入当前 MCP 使用的 Memory API_KEY" -AsSecureString
$MemoryPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($MemorySecret)
try {
    $MemoryKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($MemoryPtr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($MemoryPtr)
}

$MulticaConfig = [ordered]@{
    command = $NodeExe
    args = @($BridgeEntry)
    env = [ordered]@{
        MEMORY_ENDPOINT = "http://129.211.92.200:8420"
        PANEL_ENDPOINT = "http://129.211.92.200:8125"
        API_KEY = $MemoryKey
        SERVICE_ID = "default"
        TEAM_ID = "team-mjr65o7c2o"
        AGENT_ID = "agt-mjr6zqzts3"
        USER_ID = "usr-mjr6z7ggdp"
    }
}
$MulticaJson = $MulticaConfig | ConvertTo-Json -Depth 5
$MulticaJson
```

复制最后输出的整个 JSON，粘贴到 Multica 的 JSON 编辑框中保存。
**输出包含真实 Key，仅用于自己的配置，不要截图分享、上传知识库或提交 Git。**
如果不希望将配置输出到终端，可将最后一行 `$MulticaJson` 替换为
`$MulticaJson | Set-Clipboard`，直接复制到剪贴板；剪贴板同样包含凭证，
可能被历史记录/跨设备同步保留，请按本机安全策略处理。

这里的 ID 沿用当前用户配置。其他成员必须改为各自的用户、团队和 Agent ID，不能直接共用身份。
不要在 JSON 中写字面量 `$BridgeEntry` 或 `$MemoryKey`，必须粘贴命令实际生成的 JSON。

### 相比旧配置的变化

- `command`：由 `Get-Command node.exe` 自动获取，避免写死 Node 安装目录。
- `args`：直接使用当前 clone 根目录下的 `packages/mcp-bridge/dist/index.js`，
  不再使用旧 npm 安装目录里的入口。
- `MEMORY_ENDPOINT`：使用纯 URL，末尾无空格，不含 Markdown 链接语法。
- 新增 `PANEL_ENDPOINT`：启用 Wiki 查询。
- `API_KEY` 和三个身份 ID 沿用当前配置。未单独填写 `USER_KEY` 时复用 API_KEY，
  但 Wiki 调用仍验证该凭证属于 USER_ID；不同凭证部署需在 env 单独增加 USER_KEY。

如果现有配置还有 `TASK_ID`、`SESSION_KEY` 或其他自定义项，请保留。
没有固定 TASK_ID 时，Multica 和 Claude Code 的启动工作目录可能不同，记忆查询范围也可能不同；
先比较返回的 `_context`，不要为了接入 Wiki 随意改变已有的任务范围。

### 保存后验证

1. 确认执行端/Runtime 是安装了 Node 和这个 clone 仓库的 Windows 电脑，并且在线。
   本地安装 Multica 客户端不等于 MCP 一定在本地执行；服务器或其他电脑不能直接使用本机路径。
2. 保存配置并重新连接 MCP；若列表未刷新，重新打开会话。
3. 应出现原有三个记忆工具，以及 `wiki_list`、`wiki_search`、`wiki_read_page`。
4. 在 Multica 中发送：

```text
请调用 wiki_list 列出我有权读取的知识库，然后搜索“微信授权”，
使用 wiki_read_page 读取命中页面，根据正文回答并标注 wiki_id 和页面路径。
只查询，不写入。
```

保存配置成功或 MCP Connected 不代表远端鉴权成功，以实际工具调用结果为准。
如果仅出现三个旧工具，检查启动入口是不是源码版以及 PANEL_ENDPOINT 是否传入；
如果出现用户不匹配或 403，检查用户凭证和资产权限，不要切换到 8424 绕过校验。

配置完成后清除当前 PowerShell 中的临时变量：

```powershell
Remove-Variable MemoryKey,MemorySecret,MemoryPtr,MulticaConfig,MulticaJson -ErrorAction SilentlyContinue
```

这不会清除终端历史、剪贴板或 Multica 已保存的凭证。本文修改只更新说明，不会自动替换 Multica 的现有配置。

## 使用示例

1. “调用 wiki_list，列出当前团队我有权读取的知识库。”
2. “在刚才的 uwechat-service 知识库中用 wiki_search 搜索微信授权。”
3. “用 wiki_read_page 读取搜索结果中的相关页面，再根据正文回答，并标注知识库 ID 和页面路径。”

工具参数：

```json
{"limit":20,"offset":0}
```

```json
{"wiki_id":"wiki-实际ID","query":"微信授权","limit":10}
```

```json
{"wiki_id":"wiki-实际ID","ref":"wiki/concepts/微信授权.md"}
```

`ref` 应取自搜索结果的 `path`，不是服务器绝对文件路径。上例路径只是示例。
列表分页：每次增加 offset，直到达到 total；limit 范围 1～100。
列表返回的是已注册且有 read 权限的 Wiki 资产，包括用户可读的私有资产，不仅是团队公开资产。
`meta_status` 是资产状态，不是 Ingest 状态。搜索会读取 Wiki 详情，非 ready 则明确报错。
页面不存在时保留 `not_found: true`，不伪造空正文。读取会返回 Wiki 状态；即使能读默认
index 页面，也不代表上传的资料已经抽取成功。知识库文本仅作参考，不应被当作执行指令。

## 实际调用链及权限

| 工具 | Panel 接口（均为 POST） |
|---|---|
| 三个工具共同身份校验 | `/api/v1/meta/auth/verify`，确认 USER_KEY 对应 USER_ID |
| wiki_list | `/api/v1/meta/team-member/get` + `/api/v1/meta/asset/list-accessible`（固定 team、llm_wiki、read、分页） |
| wiki_search | `/api/v1/knowledge/wiki/get` + `/api/v1/knowledge/wiki/search` |
| wiki_read_page | `/api/v1/knowledge/wiki/get` + `/api/v1/knowledge/wiki/page/read`（`refs: [ref]`） |

Panel 在详情、搜索、页面读取时校验资产 ACL 和团队成员关系。MCP 还要求返回的
Wiki 归属配置的 TEAM_ID，避免一个有多个团队权限的用户通过工具跳到另一团队。
每次调用重新校验，不缓存权限。仅名单/描述等必要字段被返回，不回传资产内部连接信息。
HTTP 401/403、非零 envelope code、非 JSON、网络失败及超时都作为工具错误返回；
不吞掉错误伪装成空列表，不跟随重定向传递用户凭证。

## 常见问题

- 只有三个旧工具：检查是否启动了源码版 dist、是否设置 PANEL_ENDPOINT，随后重连。
- `PANEL_ENDPOINT requires USER_KEY or API_KEY`：缺少凭证，不要填模型 Key。
- `does not belong to configured USER_ID`：用户凭证与用户编号不一致。
- `NOT_TEAM_MEMBER` / `FORBIDDEN`：在 Memory 面板配置团队成员或资产读取权限，不能靠改工具参数绕过。
- 列表为空：确认 team/service/user，并确认 Wiki 已在 Panel 注册为资产；纯原始 KS 资源不会自动暴露。
- `Wiki is not ready`：先在面板解决 Ingest 错误。此工具不会自动抽取。
- `not_found`：使用搜索结果的相对路径重试。
- 请求失败：确认 Panel 8125 可达及版本匹配；不是把地址换为 8424 绕过鉴权。

## 官方源码依据

- [Panel Wiki 路由](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/0468a2a5b50eaafc54758ed1e2e6609472e5b6ce/MemoryPanel/src/panel/http/routes/knowledge/wiki-routes.ts)
- [Panel 权限门控](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/0468a2a5b50eaafc54758ed1e2e6609472e5b6ce/MemoryPanel/src/panel/http/routes/knowledge/common.ts)
- [Panel 鉴权头](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/0468a2a5b50eaafc54758ed1e2e6609472e5b6ce/MemoryPanel/src/panel/kernel/headers.ts)
- [Knowledge 原始 Wiki 路由](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/0468a2a5b50eaafc54758ed1e2e6609472e5b6ce/MemoryKnowledge/src/routes/wiki.ts)
