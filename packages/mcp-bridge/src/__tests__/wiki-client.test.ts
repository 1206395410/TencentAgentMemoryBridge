import { describe, it, expect, vi, afterEach } from 'vitest'
import { WikiClient } from '../wiki-client.js'
import { WIKI_TOOLS, callWikiTool } from '../wiki-tools.js'

const CONFIG = {
  panelEndpoint: 'https://panel.example.test/api/v1/', userKey: 'secret-user-key',
  serviceId: 'default', teamId: 'team-test', userId: 'usr-test', timeoutMs: 500,
}
const caller = { valid: true, user: { user_id: 'usr-test' } }
const detail = { wiki_id: 'wiki-test', team_id: 'team-test', name: '测试知识库', status: 'ready' }

function responses(...data: unknown[]) {
  const mock = vi.fn()
  for (const item of data) mock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: item })))
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('WikiClient (Panel ACL path)', () => {
  it('lists paginated readable Wiki assets using USER_KEY, not the Core key', async () => {
    const fetch = responses(caller, { status: 'active' }, {
      items: [{ asset_id: 'wiki-test', asset_type: 'llm_wiki', team_id: 'team-test', name: '知识库', status: 'active' }], total: 21,
    })
    const result = await new WikiClient(CONFIG).list({ limit: 10, offset: 10 })
    expect(result).toEqual({ items: [{ wiki_id: 'wiki-test', name: '知识库', team_id: 'team-test', meta_status: 'active' }], total: 21 })
    expect(fetch.mock.calls[0]![0]).toBe('https://panel.example.test/api/v1/meta/auth/verify')
    const [url, init] = fetch.mock.calls[2]!
    expect(url).toBe('https://panel.example.test/api/v1/meta/asset/list-accessible')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': CONFIG.userKey })
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body)).toEqual({ team_id: 'team-test', user_id: 'usr-test', asset_type: 'llm_wiki', action: 'read', limit: 10, offset: 10 })
    expect(JSON.stringify(result)).not.toContain(CONFIG.userKey)
  })

  it('searches via Panel after user, ACL and team checks; preserves paths for page reads', async () => {
    const result = { results: [{ path: 'wiki/concepts/微信授权.md', title: '授权', snippet: '说明', type: 'concept', score: 1 }], count: 1 }
    const fetch = responses(caller, detail, result)
    expect(await new WikiClient(CONFIG).search('wiki-test', '微信授权')).toEqual({ ...result, wiki_id: 'wiki-test', status: 'ready' })
    expect(fetch.mock.calls[1]![0]).toContain('/knowledge/wiki/get')
    expect(fetch.mock.calls[2]![0]).toContain('/knowledge/wiki/search')
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({ wiki_id: 'wiki-test', query: '微信授权', limit: 10 })
  })

  it('reads a page using refs array, not a guessed path parameter', async () => {
    const fetch = responses(caller, detail, { items: [{ ref: 'wiki/concepts/授权.md', content: '# 授权\n正文' }] })
    const data = await new WikiClient(CONFIG).readPage('wiki-test', 'wiki/concepts/授权.md')
    expect(data.items[0]!.content).toBe('# 授权\n正文')
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({ wiki_id: 'wiki-test', refs: ['wiki/concepts/授权.md'] })
    expect(fetch.mock.calls[2]![0]).toContain('/knowledge/wiki/page/read')
  })

  it('preserves not_found instead of inventing empty page content', async () => {
    responses(caller, detail, { items: [{ ref: 'missing', not_found: true }] })
    expect((await new WikiClient(CONFIG).readPage('wiki-test', 'missing')).items).toEqual([{ ref: 'missing', not_found: true }])
  })

  it('does not search a failed/un-ingested Wiki', async () => {
    const fetch = responses(caller, { ...detail, status: 'failed' })
    await expect(new WikiClient(CONFIG).search('wiki-test', 'q')).rejects.toThrow('not ready')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects USER_ID mismatch before reading any Wiki', async () => {
    const fetch = responses({ valid: true, user: { user_id: 'usr-other' } })
    await expect(new WikiClient(CONFIG).readPage('wiki-test', 'index')).rejects.toThrow('USER_ID')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid user credentials', async () => {
    responses({ valid: false })
    await expect(new WikiClient(CONFIG).list()).rejects.toThrow('USER_KEY')
  })

  it('rejects inactive membership before listing assets', async () => {
    const fetch = responses(caller, { status: 'inactive' })
    await expect(new WikiClient(CONFIG).list()).rejects.toThrow('active membership')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('blocks cross-team reads even if the caller is a member of both teams', async () => {
    const fetch = responses(caller, { ...detail, team_id: 'team-other' })
    await expect(new WikiClient(CONFIG).readPage('wiki-test', 'index')).rejects.toThrow('TEAM_ID')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fails closed on out-of-scope list results', async () => {
    responses(caller, { status: 'active' }, { items: [{ asset_id: 'wiki-other', asset_type: 'llm_wiki', team_id: 'team-other' }], total: 1 })
    await expect(new WikiClient(CONFIG).list()).rejects.toThrow('outside')
  })

  it('propagates asset ACL denial and never falls back to raw Knowledge', async () => {
    const fetch = responses(caller)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 403, message: 'FORBIDDEN' }), { status: 403 }))
    await expect(new WikiClient(CONFIG).search('wiki-test', 'q')).rejects.toThrow('403')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([url]) => url.startsWith('https://panel.example.test/api/v1/'))).toBe(true)
  })

  it.each([401, 403, 404, 500])('handles HTTP %s and redacts credentials from error messages', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: status, message: `error ${CONFIG.userKey}` }), { status })))
    const err = await new WikiClient(CONFIG).list().catch((e: Error) => e)
    expect(String(err)).toContain(`HTTP ${status}`)
    expect(String(err)).not.toContain(CONFIG.userKey)
  })

  it('rejects non-zero envelope code even with HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 401, message: 'INVALID_USER_KEY' }))))
    await expect(new WikiClient(CONFIG).list()).rejects.toThrow('INVALID_USER_KEY')
  })

  it.each(['<html>login secret-user-key</html>', '{}', 'null'])('fails on malformed envelopes without exposing raw response: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    const err = await new WikiClient(CONFIG).list().catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String(err)).not.toContain(CONFIG.userKey)
  })

  it('aborts on timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const pending = expect(new WikiClient(CONFIG).list()).rejects.toThrow('timed out after 500ms')
    await vi.advanceTimersByTimeAsync(501)
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['../secret', '/etc/passwd', 'C:\\secret', 'https://host/page', 'wiki/a\u0000.md'])('rejects unsafe page ref %s without a request', async (ref) => {
    const fetch = responses()
    await expect(new WikiClient(CONFIG).readPage('wiki-test', ref)).rejects.toThrow('ref')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['file:///tmp/a', 'https://user:pass@host', 'https://host/v3', 'https://host/?key=x'])('rejects invalid endpoint %s', (panelEndpoint) => {
    expect(() => new WikiClient({ ...CONFIG, panelEndpoint })).toThrow()
  })

  it('handles an empty accessible list', async () => {
    responses(caller, { status: 'active' }, { items: [], total: 0 })
    expect(await new WikiClient(CONFIG).list()).toEqual({ items: [], total: 0 })
  })
})

describe('Wiki tool contracts', () => {
  it('offers exactly three read-only tools', () => {
    expect(WIKI_TOOLS.map((t) => t.name)).toEqual(['wiki_list', 'wiki_search', 'wiki_read_page'])
    expect(WIKI_TOOLS.every((t) => t.annotations?.readOnlyHint && t.inputSchema.additionalProperties === false)).toBe(true)
  })

  it.each([
    ['wiki_list', { team_id: 'team-other' }],
    ['wiki_search', { wiki_id: 'wiki-test', query: '' }],
    ['wiki_search', { wiki_id: 'wiki-test', query: 'q', limit: 0 }],
    ['wiki_list', { offset: -1 }],
    ['wiki_list', { limit: 1.5 }],
    ['wiki_read_page', { wiki_id: 'wiki-test' }],
  ])('rejects invalid %s arguments before network access', async (name, args) => {
    const fetch = responses()
    await expect(callWikiTool(new WikiClient(CONFIG), name, args)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
