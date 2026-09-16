import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createRemoteHttpServer } from '../http-server.js'
import { parseRemotePolicy, type RemotePolicy } from '../remote-config.js'

const key = 'test-gateway-not-real'
const rotatedKey = 'test-rotated-gateway-not-real'
const requests: Array<{ path: string; body: Record<string, any>; userKey?: string; authorization?: string }> = []
let upstream: HttpServer
let bridge: HttpServer
let origin: string
let url: string
let policy: RemotePolicy
const clients: Client[] = []
let verifyMode = 'normal'

async function listen(server: HttpServer) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test address')
  return `http://127.0.0.1:${address.port}`
}
async function close(server: HttpServer) {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
function headers(user = 'a'): Record<string, string> {
  return { Authorization: `Bearer ${key}`, 'X-Memory-User-Key': `key-${user}`,
    'X-Memory-Service-Id': 'default', 'X-Memory-Team-Id': 'team-test',
    'X-Memory-Agent-Id': 'agt-test', 'X-Memory-User-Id': `usr-${user}`, 'X-Memory-Task-Id': 'tm' }
}
async function connect(h = headers()) {
  const client = new Client({ name: 'remote-test', version: '1.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: h } }))
  return client
}
function data(result: any) { return JSON.parse(result.content[0].text) }
async function raw(h = headers(), body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) {
  return fetch(`${url}/mcp`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) })
}

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    const userKey = req.headers['x-tdai-user-key'] as string | undefined
    requests.push({ path: req.url!, body, userKey, authorization: req.headers.authorization })
    res.setHeader('Content-Type', 'application/json')
    if (req.url?.startsWith('/v3/') && ![key, rotatedKey].some(k => req.headers.authorization === `Bearer ${k}`)) {
      res.writeHead(401)
      res.end(JSON.stringify({ code: 401, message: 'Invalid upstream credential' }))
      return
    }
    let out: unknown
    switch (req.url) {
      case '/api/v1/meta/auth/verify':
        if (verifyMode === 'redirect') { res.writeHead(302, { Location: `${origin}/leak` }); res.end(); return }
        if (verifyMode === 'malformed') { res.end('not JSON'); return }
        out = { valid: ['key-a', 'key-b', key].includes(userKey!), user: { user_id: userKey === key ? 'usr-a' : `usr-${userKey?.slice(4)}` } }; break
      case '/api/v1/meta/team-member/get': out = { status: body.team_id === 'team-off' ? 'inactive' : 'active' }; break
      case '/api/v1/meta/asset/list-accessible': out = { items: [{ asset_id: 'wiki-test', name: 'Wiki', team_id: body.team_id, asset_type: 'llm_wiki' }], total: 1 }; break
      case '/api/v1/knowledge/wiki/get': out = { wiki_id: 'wiki-test', team_id: 'team-test', name: 'Wiki', status: 'ready' }; break
      case '/api/v1/knowledge/wiki/search': out = { results: [{ path: 'wiki/test.md', snippet: 'test', title: 'test', score: 1, type: 'concept' }], count: 1 }; break
      case '/api/v1/knowledge/wiki/page/read': out = { items: [{ ref: body.refs[0], content: 'test page' }] }; break
      case '/v3/atomic/search': out = { items: [{ id: 'm1', content: `facts for ${body.user_id}` }] }; break
      case '/v3/core/read': out = { content: 'persona' }; break
      case '/v3/scenario/ls': out = { entries: [{ path: 'scene.md' }] }; break
      case '/v3/conversation/add': out = { accepted_ids: ['u', 'a'], total_count: 2 }; break
      default: res.writeHead(404); res.end(JSON.stringify({ code: 404 })); return
    }
    res.end(JSON.stringify({ code: 0, data: out }))
  })
  origin = await listen(upstream)
  policy = parseRemotePolicy({ defaultBackend: 'main', allowedHosts: ['127.0.0.1'], allowedOrigins: ['https://multica.example.test'],
    backends: [{ id: 'main', serviceId: 'default', memoryEndpoint: origin, panelEndpoint: origin }],
    grants: ['usr-a', 'usr-b'].map(userId => ({ backend: 'main', teamId: 'team-test', userId, agentId: 'agt-test', taskIds: ['tm', 'sfa'] })) })
  bridge = createRemoteHttpServer(policy)
  url = await listen(bridge)
  policy.allowedHosts.push(new URL(url).host)
})
afterAll(async () => {
  await Promise.all(clients.map(c => c.close().catch(() => {})))
  await close(bridge); await close(upstream)
})

describe('stateless remote MCP', () => {
  it('initializes and serves all six tools via real SDK HTTP transport', async () => {
    const c = await connect()
    expect((await c.listTools()).tools).toHaveLength(6)
    expect(data(await c.callTool({ name: 'search_memories', arguments: { query: '宴席' } })).items[0].content).toBe('facts for usr-a')
    const recalled = data(await c.callTool({ name: 'recall_memory', arguments: { query: '宴席', include_scenes: true } }))
    expect(recalled.persona).toBe('persona'); expect(recalled.scenes).toHaveLength(1)
    expect(data(await c.callTool({ name: 'store_memory', arguments: { user_content: 'test', assistant_content: 'ok' } })).accepted_ids).toHaveLength(2)
    expect(data(await c.callTool({ name: 'wiki_list', arguments: {} })).total).toBe(1)
    expect(data(await c.callTool({ name: 'wiki_search', arguments: { wiki_id: 'wiki-test', query: 'test' } })).count).toBe(1)
    expect(data(await c.callTool({ name: 'wiki_read_page', arguments: { wiki_id: 'wiki-test', ref: 'wiki/test.md' } })).items[0].content).toBe('test page')
  })

  it('isolates concurrent users and projects including the same session label', async () => {
    const a = await connect(); const b = await connect({ ...headers('b'), 'X-Memory-Task-Id': 'sfa' })
    const [ra, rb] = await Promise.all([a, b].map(c => c.callTool({ name: 'search_memories', arguments: { query: 'test' } })))
    expect(data(ra)._context).toMatchObject({ user_id: 'usr-a', task_id: 'tm' })
    expect(data(rb)._context).toMatchObject({ user_id: 'usr-b', task_id: 'sfa' })
    const start = requests.length
    await Promise.all([a, b].map(c => c.callTool({ name: 'store_memory', arguments: { user_content: 'u', assistant_content: 'a', session_key: 'same' } })))
    const writes = requests.slice(start).filter(r => r.path === '/v3/conversation/add')
    expect(writes).toHaveLength(2)
    expect(new Set(writes.map(w => w.body.session_id)).size).toBe(2)
    expect(new Set(writes.map(w => w.body.user_id))).toEqual(new Set(['usr-a', 'usr-b']))
  })

  it.each([
    ['Authorization', '', 401], ['Authorization', 'Basic wrong', 401],
    ['X-Memory-User-Key', 'key-b', 403], ['X-Memory-User-Key', 'bad-key', 403],
    ['X-Memory-User-Id', 'usr-unknown', 403], ['X-Memory-Team-Id', 'team-other', 403],
    ['X-Memory-Agent-Id', 'agt-other', 403], ['X-Memory-Service-Id', 'other', 403],
    ['X-Memory-Task-Id', 'unknown', 403], ['X-Memory-Task-Id', '', 400],
    ['X-Memory-Task-Id', 'agt-test', 400], ['X-Memory-Typo', 'x', 400],
    ['Origin', 'https://evil.example', 403], ['Mcp-Session-Id', 'stolen', 400],
    ['X-Memory-Endpoint', 'http://169.254.169.254', 400],
  ])('rejects invalid header %s=%s', async (name, value, status) => {
    const before = requests.filter(r => r.path.startsWith('/v3/')).length
    const res = await raw({ ...headers(), [name]: value as string })
    expect(res.status).toBe(status)
    expect(await res.text()).not.toContain(key)
    expect(requests.filter(r => r.path.startsWith('/v3/')).length).toBe(before)
  })

  it('requires active membership even when explicitly granted', async () => {
    policy.grants.push({ ...policy.grants[0]!, teamId: 'team-off' })
    expect((await raw({ ...headers(), 'X-Memory-Team-Id': 'team-off' })).status).toBe(403)
  })
  it('forwards different gateway keys per request without a configured digest', async () => {
    const a = await connect()
    const b = await connect({ ...headers('b'), Authorization: `Bearer ${rotatedKey}` })
    const start = requests.length
    const results = await Promise.all([a, b].map(c => c.callTool({ name: 'search_memories', arguments: { query: 'test' } })))
    expect(results.every(r => !r.isError)).toBe(true)
    const searches = requests.slice(start).filter(r => r.path === '/v3/atomic/search')
    expect(searches).toHaveLength(2)
    expect(searches.find(r => r.body.user_id === 'usr-a')?.authorization).toBe(`Bearer ${key}`)
    expect(searches.find(r => r.body.user_id === 'usr-b')?.authorization).toBe(`Bearer ${rotatedKey}`)
  })
  it('leaves gateway credential validation to Core while still requiring personal authentication', async () => {
    const c = await connect({ ...headers(), Authorization: 'Bearer invalid-gateway' })
    expect((await c.listTools()).tools).toHaveLength(6)
    const result = await c.callTool({ name: 'search_memories', arguments: { query: 'test' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('invalid-gateway')
    const h: Record<string, string> = { ...headers(), Authorization: 'Bearer invalid-gateway' }
    delete h['X-Memory-User-Key']
    expect((await raw(h)).status).toBe(403)
  })
  it('ignores obsolete gateway digests in existing policies', () => {
    const parsed = parseRemotePolicy({ ...policy, backends: [{ ...policy.backends[0], apiKeySha256: ['obsolete-value'] }] })
    expect(parsed.backends[0]).not.toHaveProperty('apiKeySha256')
  })
  it('allows API_KEY reuse only if Panel verifies its user identity', async () => {
    const h = headers(); delete h['X-Memory-User-Key']
    expect((await raw(h)).status).toBe(200)
    expect((await raw({ ...h, 'X-Memory-User-Id': 'usr-b' })).status).toBe(403)
  })
  it('rejects non-allowlisted endpoints without sending a credential to them', async () => {
    const before = requests.length
    expect((await raw({ ...headers(), 'X-Memory-Endpoint': 'http://169.254.169.254', 'X-Memory-Panel-Endpoint': origin })).status).toBe(403)
    expect(requests.length).toBe(before)
    expect((await raw({ ...headers(), 'X-Memory-Endpoint': origin, 'X-Memory-Panel-Endpoint': `${origin}/api/v1` })).status).toBe(200)
  })
  it('revalidates revoked credentials on each call and fails closed on redirect/malformed responses', async () => {
    const c = await connect()
    const grants = policy.grants
    try {
      policy.grants = grants.filter(g => g.userId !== 'usr-a')
      await expect(c.listTools()).rejects.toThrow()
      policy.grants = grants
      verifyMode = 'redirect'
      expect((await raw()).status).toBe(503)
      expect(requests.some(r => r.path === '/leak')).toBe(false)
      verifyMode = 'malformed'
      await expect(c.listTools()).rejects.toThrow()
    } finally { verifyMode = 'normal'; policy.grants = grants }
  })
  it('checks Origin/Host, supports explicit CORS and returns 405 for GET/DELETE', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${url}/mcp`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    expect(status).toBe(403)
    for (const method of ['GET', 'DELETE']) expect((await fetch(`${url}/mcp`, { method })).status).toBe(405)
    const res = await fetch(`${url}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://multica.example.test' } })
    expect(res.status).toBe(204); expect(res.headers.get('access-control-allow-origin')).toBe('https://multica.example.test')
    expect((await fetch(`${url}/health`)).status).toBe(200)
  })
  it('rejects oversized and invalid payloads', async () => {
    expect((await raw(headers(), { huge: 'x'.repeat(1024 * 1024) })).status).toBe(413)
    expect((await raw(headers(), [])).status).toBe(400)
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: headers(), body: 'oops' })).status).toBe(415)
  })
  it('rejects duplicate security headers', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${url}/mcp`, { method: 'POST', headers: { ...headers(), 'X-Memory-User-Id': ['usr-a', 'usr-b'] } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    expect(status).toBe(400)
  })
  it('returns 413 for chunked oversized bodies too', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${url}/mcp`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.write('x'.repeat(1024 * 1024 + 1)); req.end()
    })
    expect(status).toBe(413)
  })
  it('does not allow tool arguments to override identities or endpoints', async () => {
    const c = await connect()
    const before = requests.filter(r => r.path.startsWith('/v3/')).length
    for (const args of [{ query: 'q', user_id: 'usr-b' }, { query: 'q', limit: 10000 }, { query: 5 }]) {
      expect((await c.callTool({ name: 'search_memories', arguments: args })).isError).toBe(true)
    }
    expect(requests.filter(r => r.path.startsWith('/v3/')).length).toBe(before)
  })
  it('rejects unsafe or incomplete startup policies', () => {
    expect(() => parseRemotePolicy({})).toThrow()
    expect(() => parseRemotePolicy({ ...policy, grants: [] })).toThrow()
    expect(() => parseRemotePolicy({ ...policy, allowedHosts: ['*'] })).toThrow()
    expect(() => parseRemotePolicy({ ...policy, backends: [{ ...policy.backends[0], memoryEndpoint: 'http://user:pass@localhost' }] })).toThrow()
  })
})
