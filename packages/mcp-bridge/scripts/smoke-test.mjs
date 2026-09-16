// Read-only integration smoke test against a local fake Panel/Core, never production.
// Run `pnpm build` first. Exercises the actual compiled stdio MCP entry.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const requests = []
const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests.push({ path: req.url, body, headers: req.headers })
  let data
  let code = 0
  switch (req.url) {
    case '/api/v1/meta/auth/verify': data = { valid: true, user: { user_id: 'usr-test' } }; break
    case '/api/v1/meta/team-member/get': data = { status: 'active' }; break
    case '/api/v1/meta/asset/list-accessible':
      data = { items: [{ asset_id: 'wiki-test', team_id: 'team-test', asset_type: 'llm_wiki', name: '授权说明', status: 'active' }], total: 1 }; break
    case '/api/v1/knowledge/wiki/get':
      if (body.wiki_id === 'wiki-denied') { code = 403; break }
      data = { wiki_id: 'wiki-test', team_id: 'team-test', name: '授权说明', status: 'ready' }; break
    case '/api/v1/knowledge/wiki/search':
      data = { results: [{ path: 'wiki/concepts/授权.md', title: '授权', snippet: '示例', score: 1, type: 'concept' }], count: 1 }; break
    case '/api/v1/knowledge/wiki/page/read':
      data = { items: [{ ref: body.refs[0], content: '# 授权\n仅测试数据' }] }; break
    case '/v3/atomic/search': data = { items: [] }; break
    default: code = 404
  }
  res.writeHead(code || 200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code, message: code ? 'FORBIDDEN' : 'ok', data }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const endpoint = `http://127.0.0.1:${server.address().port}`
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key))),
  MEMORY_ENDPOINT: endpoint, API_KEY: 'fake-core-key', SERVICE_ID: 'default',
  TEAM_ID: 'team-test', USER_ID: 'usr-test', AGENT_ID: 'agt-test', TASK_ID: 'smoke-test',
  SESSION_KEY: 'smoke-session', TIMEOUT_MS: '3000',
}

async function withClient(wiki, check) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry],
    env: { ...env, PANEL_ENDPOINT: wiki ? endpoint : '', USER_KEY: wiki ? 'fake-user-key' : '' }, stderr: 'pipe' })
  const client = new Client({ name: 'wiki-smoke', version: '1.0.0' })
  try { await client.connect(transport); await check(client) }
  finally { await client.close() }
}
try {
  await withClient(false, async (client) => {
    assert.equal((await client.listTools()).tools.length, 3)
    const result = await client.callTool({ name: 'search_memories', arguments: { query: 'test' } })
    assert.ok(!result.isError)
    assert.deepEqual(JSON.parse(result.content[0].text).items, [])
    const disabled = await client.callTool({ name: 'wiki_list', arguments: {} })
    assert.equal(disabled.isError, true)
  })
  await withClient(true, async (client) => {
    const tools = (await client.listTools()).tools
    assert.equal(tools.length, 6)
    for (const name of ['wiki_list', 'wiki_search', 'wiki_read_page']) {
      assert.equal(tools.find((tool) => tool.name === name).annotations.readOnlyHint, true)
    }
    const list = await client.callTool({ name: 'wiki_list', arguments: {} })
    assert.ok(!list.isError)
    const wiki = JSON.parse(list.content[0].text).items[0]
    assert.equal(wiki.wiki_id, 'wiki-test')
    const search = await client.callTool({ name: 'wiki_search', arguments: { wiki_id: wiki.wiki_id, query: '授权' } })
    assert.ok(!search.isError)
    const hit = JSON.parse(search.content[0].text).results[0]
    const page = await client.callTool({ name: 'wiki_read_page', arguments: { wiki_id: wiki.wiki_id, ref: hit.path } })
    assert.ok(!page.isError)
    assert.equal(JSON.parse(page.content[0].text).items[0].content, '# 授权\n仅测试数据')
    assert.ok(!JSON.stringify(page).includes('fake-user-key'))
    const denied = await client.callTool({ name: 'wiki_read_page', arguments: { wiki_id: 'wiki-denied', ref: 'index' } })
    assert.equal(denied.isError, true)
    const before = requests.length
    const invalid = await client.callTool({ name: 'wiki_list', arguments: { team_id: 'team-other' } })
    assert.equal(invalid.isError, true)
    assert.equal(requests.length, before)
    const legacy = await client.callTool({ name: 'search_memories', arguments: { query: 'test' } })
    assert.ok(!legacy.isError)
  })
  for (const request of requests.filter((r) => r.path.startsWith('/api/v1/'))) {
    assert.equal(request.headers['x-tdai-user-key'], 'fake-user-key')
    assert.equal(request.headers.authorization, undefined)
  }
  assert.ok(!requests.some((r) => /ingest|create|delete|write|conversation\/add/.test(r.path)))
  console.log('PASS: compiled stdio MCP; legacy tools, Wiki list/search/read, ACL denial, input validation; no writes.')
} finally {
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
