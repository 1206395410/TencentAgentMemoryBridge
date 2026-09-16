import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMemoryServer } from './server.js'
import { checkHeaders, RemoteError, resolveRemoteConfig, verifyRemoteIdentity, type RemotePolicy } from './remote-config.js'

const MAX_BODY = 1024 * 1024
const CORS_HEADERS = 'Authorization, Content-Type, Accept, MCP-Protocol-Version, X-Memory-Service-Id, X-Memory-Team-Id, X-Memory-Agent-Id, X-Memory-User-Id, X-Memory-Task-Id, X-Memory-User-Key, X-Memory-Endpoint, X-Memory-Panel-Endpoint, X-Memory-Session-Key'
function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }))
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new RemoteError(415, 'Expected application/json')
  if (Number(req.headers['content-length']) > MAX_BODY) throw new RemoteError(413, 'Request too large')
  const chunks: Buffer[] = []
  let bytes = 0
  // Keep the socket open on oversized chunked bodies so the caller receives 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new RemoteError(413, 'Request too large')
    chunks.push(chunk)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid RPC object')
    return body
  } catch { throw new RemoteError(400, 'Invalid JSON-RPC body') }
}

/** Stateless Streamable HTTP: fresh transport + tools + credentials per POST. No session cookie. */
export function createRemoteHttpServer(policy: RemotePolicy) {
  let inFlight = 0
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    let acquired = false
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      checkHeaders(req)
      if (!policy.allowedHosts.includes((req.headers.host || '').toLowerCase())) throw new RemoteError(403, 'Host not allowed')
      const origin = req.headers.origin
      if (origin) {
        if (!policy.allowedOrigins.includes(origin)) throw new RemoteError(403, 'Origin not allowed')
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
      }
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); return
      }
      if (req.url !== '/mcp') throw new RemoteError(404, 'Not found')
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS)
        res.writeHead(204); res.end(); return
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS')
        throw new RemoteError(405, 'Stateless MCP accepts POST; no standalone SSE or DELETE session')
      }
      if (req.headers['mcp-session-id']) throw new RemoteError(400, 'Stateless server does not accept MCP session IDs')
      if (inFlight >= 32) throw new RemoteError(429, 'Too many concurrent requests')
      inFlight++; acquired = true
      const config = resolveRemoteConfig(req, policy)
      const body = await readBody(req)
      await verifyRemoteIdentity(config)
      if (res.destroyed) return
      const mcp = createMemoryServer(config, true)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      try {
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
      } finally { await mcp.close() }
    } catch (error) {
      fail(res, error instanceof RemoteError ? error.status : 500,
        error instanceof RemoteError ? error.message : 'Remote MCP request failed')
      // Drain rejected bodies without retaining them; socket timeout still bounds slow clients.
      if (!req.complete) req.resume()
    } finally { if (acquired) inFlight-- }
  })
  server.setTimeout(30000, socket => socket.destroy())
  return server
}
