import type { IncomingMessage } from 'node:http'
import type { McpConfig } from './config.js'

export class RemoteError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
export interface RemoteBackend {
  id: string
  serviceId: string
  memoryEndpoint: string
  panelEndpoint: string
}
export interface RemotePolicy {
  defaultBackend: string
  allowedHosts: string[]
  allowedOrigins: string[]
  backends: RemoteBackend[]
  grants: Array<{ backend: string; teamId: string; userId: string; agentId: string; taskIds: string[] }>
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected configuration object')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error('Invalid configuration text')
  return value
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Expected nonempty configuration list')
  return value
}
function id(value: unknown): string {
  const s = text(value)
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) throw new Error('Invalid identity')
  return s
}
function task(value: unknown): string {
  const s = text(value)
  // ASCII project labels travel reliably in HTTP headers, even from Windows clients.
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(s) || /^(agt-|team-|usr-|uky-|sk-|key-)/i.test(s)) throw new Error('Invalid task label')
  return s
}
export function endpoint(value: unknown, panel = false): string {
  const url = new URL(text(value))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !['', ...(panel ? ['/api/v1'] : [])].includes(url.pathname.replace(/\/+$/, ''))) throw new Error('Invalid upstream origin')
  return url.origin
}
export function parseRemotePolicy(value: unknown): RemotePolicy {
  const raw = object(value)
  const backends = list(raw.backends).map(v => {
    const b = object(v)
    return { id: id(b.id), serviceId: id(b.serviceId), memoryEndpoint: endpoint(b.memoryEndpoint),
      panelEndpoint: endpoint(b.panelEndpoint, true) }
  })
  if (new Set(backends.map(b => b.id)).size !== backends.length) throw new Error('Duplicate backend ID')
  if (new Set(backends.map(b => JSON.stringify([b.serviceId, b.memoryEndpoint, b.panelEndpoint]))).size !== backends.length) throw new Error('Ambiguous backend origins')
  const defaultBackend = id(raw.defaultBackend)
  if (!backends.some(b => b.id === defaultBackend)) throw new Error('Unknown default backend')
  const allowedHosts = list(raw.allowedHosts).map(text)
  if (allowedHosts.some(h => !/^[a-z0-9.[\]:-]+$/.test(h))) throw new Error('Hosts must be exact lowercase host[:port] values')
  const allowedOrigins = raw.allowedOrigins === undefined ? [] : (Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins : list(raw.allowedOrigins)).map(v => endpoint(v))
  const grants = list(raw.grants).map(v => {
    const g = object(v)
    const backend = id(g.backend)
    if (!backends.some(b => b.id === backend)) throw new Error('Grant references unknown backend')
    return { backend, teamId: id(g.teamId), userId: id(g.userId), agentId: id(g.agentId), taskIds: list(g.taskIds).map(task) }
  })
  return { defaultBackend, allowedHosts, allowedOrigins, backends, grants }
}

const REMOTE_HEADERS = new Set(['x-memory-service-id', 'x-memory-team-id', 'x-memory-agent-id',
  'x-memory-user-id', 'x-memory-task-id', 'x-memory-user-key', 'x-memory-endpoint',
  'x-memory-panel-endpoint', 'x-memory-session-key'])

export function checkHeaders(req: IncomingMessage): void {
  const seen = new Set<string>()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase()
    if (name.startsWith('x-memory-') && !REMOTE_HEADERS.has(name)) throw new RemoteError(400, 'Unknown Memory header')
    if (['authorization', 'host', 'origin', 'mcp-session-id'].includes(name) || REMOTE_HEADERS.has(name)) {
      if (seen.has(name)) throw new RemoteError(400, 'Duplicate security header')
      seen.add(name)
    }
  }
}
function header(req: IncomingMessage, name: string, optional = false): string {
  const v = req.headers[name]
  if (v === undefined && optional) return ''
  if (typeof v !== 'string' || !v.trim() || v.length > 4096 || /[\x00-\x1f\x7f]/.test(v)) throw new RemoteError(400, `Missing or invalid ${name}`)
  return v.trim()
}

export function resolveRemoteConfig(req: IncomingMessage, policy: RemotePolicy): McpConfig {
  checkHeaders(req)
  if (typeof req.headers.authorization !== 'string' || !req.headers.authorization.trim()) throw new RemoteError(401, 'Memory credential required')
  const auth = header(req, 'authorization', true)
  if (!/^Bearer [^\s]+$/i.test(auth)) throw new RemoteError(401, 'Memory credential required')
  const apiKey = auth.slice(7)
  try {
    const serviceId = id(header(req, 'x-memory-service-id'))
    const teamId = id(header(req, 'x-memory-team-id'))
    const agentId = id(header(req, 'x-memory-agent-id'))
    const userId = id(header(req, 'x-memory-user-id'))
    const taskId = task(header(req, 'x-memory-task-id'))
    const core = header(req, 'x-memory-endpoint', true)
    const panel = header(req, 'x-memory-panel-endpoint', true)
    if (Boolean(core) !== Boolean(panel)) throw new RemoteError(400, 'Provide both upstream endpoints or neither')
    const backend = core ? policy.backends.find(b => b.serviceId === serviceId &&
      b.memoryEndpoint === endpoint(core) && b.panelEndpoint === endpoint(panel, true))
      : policy.backends.find(b => b.id === policy.defaultBackend && b.serviceId === serviceId)
    if (!backend) throw new RemoteError(403, 'Upstream is not allowed')
    // Forward the caller's gateway credential; Core validates it on business requests.
    // Personal identity and explicit grants remain enforced by the Bridge.
    if (!policy.grants.some(g => g.backend === backend.id && g.teamId === teamId && g.userId === userId &&
      g.agentId === agentId && g.taskIds.includes(taskId))) throw new RemoteError(403, 'Identity or project is not authorized')
    const session = header(req, 'x-memory-session-key', true)
    if (session && !/^[A-Za-z0-9_.-]{1,200}$/.test(session)) throw new RemoteError(400, 'Invalid session label')
    return { endpoint: backend.memoryEndpoint, panelEndpoint: backend.panelEndpoint,
      apiKey, userKey: header(req, 'x-memory-user-key', true) || apiKey,
      serviceId, teamId, agentId, userId, taskId,
      sessionKey: session || `daily-${new Date().toISOString().slice(0, 10)}`, timeoutMs: 15000 }
  } catch (e) {
    if (e instanceof RemoteError) throw e
    throw new RemoteError(400, 'Invalid Memory connection configuration')
  }
}

/** Authenticate on EVERY request, including initialize/listTools. Never cache identity globally. */
export async function verifyRemoteIdentity(config: McpConfig): Promise<void> {
  async function post(route: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await fetch(`${config.panelEndpoint}/api/v1${route}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', 'x-tdai-service-id': config.serviceId, 'x-tdai-user-key': config.userKey! },
        body: JSON.stringify(body),
      })
    } catch { throw new RemoteError(503, 'Identity service unavailable') }
    if ([401, 403].includes(res.status)) throw new RemoteError(403, 'User authentication rejected')
    let env: Record<string, unknown>
    try { env = object(await res.json()) } catch { throw new RemoteError(503, 'Invalid identity service response') }
    if (env.code === 401 || env.code === 403) throw new RemoteError(403, 'User authentication rejected')
    if (!res.ok || env.code !== 0) throw new RemoteError(503, 'Identity service rejected request')
    try { return object(env.data) } catch { throw new RemoteError(503, 'Invalid identity data') }
  }
  const verified = await post('/meta/auth/verify', { user_key: config.userKey })
  if (verified.valid !== true || !verified.user || typeof verified.user !== 'object' ||
    (verified.user as Record<string, unknown>).user_id !== config.userId) throw new RemoteError(403, 'Credential does not match USER_ID')
  const membership = await post('/meta/team-member/get', { team_id: config.teamId, user_id: config.userId })
  if (membership.status !== 'active') throw new RemoteError(403, 'Active team membership required')
}
