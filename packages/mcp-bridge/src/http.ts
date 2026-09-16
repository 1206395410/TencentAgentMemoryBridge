#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseRemotePolicy } from './remote-config.js'
import { createRemoteHttpServer } from './http-server.js'

try {
  const policyPath = process.env.MCP_REMOTE_CONFIG
  if (!policyPath) throw new Error('MCP_REMOTE_CONFIG is required')
  const policy = parseRemotePolicy(JSON.parse(readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, '')))
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1'
  const port = Number(process.env.MCP_HTTP_PORT || 8430)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP_HTTP_PORT')
  const server = createRemoteHttpServer(policy)
  server.on('error', () => { console.error('Remote MCP listener failed'); process.exitCode = 1 })
  server.listen(port, host, () => console.error(`Remote MCP listening on ${host}:${port}/mcp; expose only through HTTPS or a protected network`))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => { process.exitCode = 0 })
      setTimeout(() => { server.closeAllConnections() }, 5000).unref()
    })
  }
} catch {
  console.error('Remote MCP startup failed: check MCP_REMOTE_CONFIG, policy fields and listen settings (credentials omitted)')
  process.exitCode = 1
}
