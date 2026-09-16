import { createHash } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { McpConfig } from './config.js'
import { V3MemoryClient } from './client.js'
import { WikiClient } from './wiki-client.js'
import { WIKI_TOOLS, callWikiTool } from './wiki-tools.js'

/** One immutable identity per instance; HTTP creates a fresh instance per request. */
export function createMemoryServer(config: McpConfig, remote = false): Server {
  const client = new V3MemoryClient(config)
  const wikiClient = config.panelEndpoint && config.userKey ? new WikiClient({
    panelEndpoint: config.panelEndpoint, userKey: config.userKey,
    serviceId: config.serviceId, teamId: config.teamId, userId: config.userId,
    timeoutMs: config.timeoutMs,
  }) : undefined

  const TOOLS: Tool[] = [
    {
      name: 'recall_memory',
      description:
        'Recall relevant memories for the CURRENT task (project). Returns L1 facts (project-scoped by task_id) plus optionally L3 persona and L2 scene index. ' +
        'Identity (team_id/agent_id/user_id) and task_id are fixed by the MCP server environment — never pass or guess them. ' +
        'agent_id is the platform identity (agt-*), task_id is the project label; they are different concepts and must not be mixed. ' +
        'Results include a _context block echoing the active isolation domain.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for relevant memories' },
          limit: { type: 'number', description: 'Max L1 facts to return (default 5)' },
          include_persona: { type: 'boolean', description: 'Include L3 persona (default true)' },
          include_scenes: { type: 'boolean', description: 'Include L2 scene index (default false)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'store_memory',
      description:
        'Store a conversation turn into L0 memory (write path, requires a session). ' +
        'Writes under the isolation triple (team_id/agent_id/user_id) and task_id fixed by the MCP server environment — no identity or task parameters are accepted. ' +
        'task_id is the project label, NOT the agent_id: do not invent or swap them. ' +
        'Results include a _context block echoing the active isolation domain.',
      inputSchema: {
        type: 'object',
        properties: {
          user_content: { type: 'string', description: 'User input text' },
          assistant_content: { type: 'string', description: 'Assistant response text' },
          session_key: { type: 'string', description: 'Session key (default: auto per agent+day)' },
        },
        required: ['user_content', 'assistant_content'],
      },
    },
    {
      name: 'search_memories',
      description:
        'Semantic search across L1 atomic memories of the CURRENT task (project-scoped by task_id). ' +
        'Identity and task_id come from the MCP server environment — do not pass agent_id/team_id/user_id/task_id. ' +
        'Results include a _context block echoing the active isolation domain.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Maximum number of results' },
          type: { type: 'string', description: 'Filter by memory type' },
        },
        required: ['query'],
      },
    },
  ]

  const server = new Server(
    { name: 'tencent-agent-memory-mcp-bridge', version: '0.4.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS, ...(wikiClient ? WIKI_TOOLS : [])] }))

  /**
   * 回显当前隔离上下文（不含任何 key）。让模型/用户明确感知本次调用落在
   * 哪个 (team, agent, user, task) 域，避免把 agent_id 当 task_id 用或反之。
   */
  function contextEcho(): Record<string, string | undefined> {
    return {
      team_id: config.teamId,
      agent_id: config.agentId,
      user_id: config.userId,
      task_id: config.taskId,
    }
  }

  function resolveSession(sessionKey: string | undefined | null): string {
    const label = sessionKey || config.sessionKey
    if (!remote) return label
    return 'remote-' + createHash('sha256').update(JSON.stringify([
      config.endpoint, config.serviceId, config.teamId, config.agentId, config.userId, config.taskId, label,
    ])).digest('hex')
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      if (remote) {
        const tool = [...TOOLS, ...WIKI_TOOLS].find(t => t.name === name)
        if (!tool) throw new Error('Unknown tool')
        const allowed = Object.keys(tool.inputSchema.properties ?? {})
        if (Object.keys(args ?? {}).some(k => !allowed.includes(k))) throw new Error('Unexpected argument')
        for (const field of tool.inputSchema.required ?? []) {
          if (typeof args?.[field] !== 'string' || !(args[field] as string).trim()) throw new Error('Missing text argument')
        }
        for (const [key, value] of Object.entries(args ?? {})) {
          if (key === 'limit' && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100)) throw new Error('Invalid limit')
          if (key.startsWith('include_') && typeof value !== 'boolean') throw new Error('Invalid boolean')
          if (!['limit', 'offset', 'include_persona', 'include_scenes'].includes(key) &&
            (typeof value !== 'string' || value.length > (key.endsWith('_content') ? 100000 : 4000))) throw new Error('Invalid text argument')
        }
      }
      if (WIKI_TOOLS.some((tool) => tool.name === name)) {
        if (!wikiClient) throw new Error('Wiki tools require PANEL_ENDPOINT and a valid user credential (USER_KEY or reused API_KEY); existing memory tools remain available')
        const data = await callWikiTool(wikiClient, name, args)
        return { content: [{ type: 'text', text: JSON.stringify({
          ...data,
          _context: { service_id: config.serviceId, team_id: config.teamId, user_id: config.userId },
        }) }] }
      }
      switch (name) {
        case 'recall_memory': {
          const query = args?.query as string
          const limit = (args?.limit as number | undefined) ?? 5
          const includePersona = args?.include_persona !== false
          const includeScenes = args?.include_scenes === true

          const [facts, persona, scenes] = await Promise.all([
            client.searchAtomic(query, { limit }),
            includePersona ? client.readCore() : Promise.resolve(null),
            includeScenes ? client.listScenarios() : Promise.resolve(null),
          ])

          const result: Record<string, unknown> = {
            facts: facts.items ?? [],
          }
          if (includePersona && persona?.content) result.persona = persona.content
          if (includeScenes && scenes?.entries?.length) result.scenes = scenes.entries
          result._context = contextEcho()
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }

        case 'store_memory': {
          const data = await client.addConversation(
            [
              { role: 'user', content: args?.user_content as string },
              { role: 'assistant', content: args?.assistant_content as string },
            ],
            resolveSession(args?.session_key as string | undefined),
          )
          const out = { ...data, _context: contextEcho() }
          return { content: [{ type: 'text', text: JSON.stringify(out) }] }
        }

        case 'search_memories': {
          const data = await client.searchAtomic(args?.query as string, {
            limit: (args?.limit as number | undefined) ?? 5,
            type: args?.type as string | undefined,
          })
          return {
            content: [
              { type: 'text', text: JSON.stringify({ items: data.items ?? [], _context: contextEcho() }) },
            ],
          }
        }

        default:
          throw new Error(`Unknown tool: ${name}`)
      }
    } catch (err) {
      const message = remote ? 'Memory request failed; check arguments, permissions and upstream availability'
        : err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      }
    }
  })

  return server
}
