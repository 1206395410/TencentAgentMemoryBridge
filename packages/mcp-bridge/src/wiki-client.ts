/** Read-only Wiki access through MemoryPanel. Never bypass Panel ACL via port 8424. */
export interface WikiClientConfig {
  panelEndpoint: string
  userKey: string
  serviceId: string
  teamId: string
  userId: string
  timeoutMs?: number
}

export interface WikiSummary {
  wiki_id: string
  name: string
  team_id: string
  meta_status?: string
  description?: string | null
}

export interface WikiDetail {
  wiki_id: string
  team_id: string
  name: string
  status: string
}

export interface WikiSearchResult {
  results: Array<{ path: string; title: string; snippet: string; score: number; type: string }>
  count: number
  links?: unknown[]
}

export interface WikiPageResult {
  items: Array<{ ref: string; content?: string; not_found?: boolean }>
}

type JsonObject = Record<string, unknown>

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function wikiText(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string (max ${max} characters)`)
  }
  return value.trim()
}

export function wikiInteger(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}`)
  }
  return value
}

function wikiId(value: unknown): string {
  const id = wikiText(value, 'wiki_id')
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid wiki_id')
  return id
}

function pageRef(value: unknown): string {
  const ref = wikiText(value, 'ref', 1024)
  // Accept relative Wiki page paths/IDs only, never URLs or filesystem paths.
  if (ref.startsWith('/') || ref.includes('..') || /[\\:\x00-\x1f\x7f]/.test(ref)) {
    throw new Error('ref must be a relative Wiki page path or ID, without traversal')
  }
  return ref
}

export class WikiClient {
  private readonly baseUrl: string
  private readonly config: WikiClientConfig

  constructor(config: WikiClientConfig) {
    const url = new URL(config.panelEndpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('PANEL_ENDPOINT must be an HTTP(S) URL without credentials, query or fragment')
    }
    const path = url.pathname.replace(/\/+$/, '')
    if (path !== '' && path !== '/api/v1') {
      throw new Error('PANEL_ENDPOINT must be the Panel origin or end with /api/v1')
    }
    this.baseUrl = `${url.origin}/api/v1`
    this.config = { ...config }
    wikiText(config.userKey, 'USER_KEY', 4096)
    for (const [label, value] of Object.entries({ SERVICE_ID: config.serviceId, TEAM_ID: config.teamId, USER_ID: config.userId })) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error(`Invalid ${label}`)
    }
    wikiInteger(config.timeoutMs, 'timeoutMs', 15000, 1, 300000)
  }

  private async post<T>(path: string, body: JsonObject): Promise<T> {
    const controller = new AbortController()
    const timeoutMs = this.config.timeoutMs ?? 15000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'error', // Never forward the user credential across redirects.
        headers: {
          'Content-Type': 'application/json',
          'x-tdai-service-id': this.config.serviceId,
          'x-tdai-user-key': this.config.userKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      let env: unknown
      try { env = JSON.parse(await res.text()) } catch {
        throw new Error(`Wiki Panel ${path}: non-JSON response (HTTP ${res.status}); check PANEL_ENDPOINT`)
      }
      if (!object(env) || typeof env.code !== 'number') {
        throw new Error(`Wiki Panel ${path}: invalid response envelope (HTTP ${res.status})`)
      }
      if (!res.ok || env.code !== 0) {
        const message = typeof env.message === 'string'
          ? env.message.split(this.config.userKey).join('[REDACTED]').slice(0, 300)
          : 'Request rejected'
        throw new Error(`Wiki Panel ${path}: HTTP ${res.status}, code=${env.code}: ${message}`)
      }
      if (!object(env.data)) throw new Error(`Wiki Panel ${path}: missing response data`)
      return env.data as T
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Wiki Panel ${path}: timed out after ${timeoutMs}ms`)
      if (err instanceof Error && err.message.startsWith('Wiki Panel ')) throw err
      throw new Error(`Wiki Panel ${path}: connection failed; check Panel address, TLS and network`)
    } finally {
      clearTimeout(timer)
    }
  }

  private async verifyCaller(): Promise<void> {
    const data = await this.post<{ valid?: boolean; user?: { user_id?: string } }>(
      '/meta/auth/verify', { user_key: this.config.userKey },
    )
    if (data.valid !== true || data.user?.user_id !== this.config.userId) {
      throw new Error('Wiki USER_KEY is invalid or does not belong to configured USER_ID')
    }
  }

  /** Paginated, ACL-filtered metadata list; status here is NOT the ingest status. */
  async list(opts: { limit?: number; offset?: number } = {}): Promise<{ items: WikiSummary[]; total: number }> {
    const limit = wikiInteger(opts.limit, 'limit', 20, 1, 100)
    const offset = wikiInteger(opts.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
    await this.verifyCaller()
    const member = await this.post<{ status?: string }>('/meta/team-member/get', {
      team_id: this.config.teamId, user_id: this.config.userId,
    })
    if (member.status !== 'active') throw new Error('Wiki access requires active membership in configured TEAM_ID')
    const data = await this.post<{ items: JsonObject[]; total: number }>('/meta/asset/list-accessible', {
      team_id: this.config.teamId, user_id: this.config.userId,
      asset_type: 'llm_wiki', action: 'read', limit, offset,
    })
    if (!Array.isArray(data.items) || !Number.isInteger(data.total) || data.total < 0) {
      throw new Error('Wiki Panel returned an invalid asset list')
    }
    const items = data.items.map((item): WikiSummary => {
      if (!object(item) || item.team_id !== this.config.teamId || item.asset_type !== 'llm_wiki') {
        throw new Error('Wiki Panel returned an asset outside the configured team/type')
      }
      return {
        wiki_id: wikiId(item.asset_id), name: wikiText(item.name, 'Wiki name', 4096),
        team_id: this.config.teamId,
        meta_status: typeof item.status === 'string' ? item.status : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
      }
    })
    return { items, total: data.total }
  }

  private async detail(id: string): Promise<WikiDetail> {
    await this.verifyCaller()
    // Panel checks the caller's asset read ACL and team membership on EVERY call.
    const detail = await this.post<WikiDetail>('/knowledge/wiki/get', { wiki_id: id })
    if (detail.team_id !== this.config.teamId || detail.wiki_id !== id) {
      throw new Error('Wiki is outside the configured TEAM_ID or returned a mismatched ID')
    }
    return detail
  }

  async search(id: string, query: string, limit?: number): Promise<WikiSearchResult & { wiki_id: string; status: string }> {
    id = wikiId(id)
    query = wikiText(query, 'query', 4000)
    limit = wikiInteger(limit, 'limit', 10, 1, 100)
    const detail = await this.detail(id)
    if (detail.status !== 'ready') {
      throw new Error(`Wiki is not ready (status=${detail.status}); finish Ingest in the Panel first`)
    }
    const data = await this.post<WikiSearchResult>('/knowledge/wiki/search', { wiki_id: id, query, limit })
    if (!Array.isArray(data.results) || typeof data.count !== 'number') throw new Error('Invalid Wiki search response')
    return { ...data, wiki_id: id, status: detail.status }
  }

  async readPage(id: string, ref: string): Promise<WikiPageResult & { wiki_id: string; status: string }> {
    id = wikiId(id)
    ref = pageRef(ref)
    const detail = await this.detail(id)
    const data = await this.post<WikiPageResult>('/knowledge/wiki/page/read', { wiki_id: id, refs: [ref] })
    if (!Array.isArray(data.items)) throw new Error('Invalid Wiki page response')
    return { ...data, wiki_id: id, status: detail.status }
  }
}
