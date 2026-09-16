#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { createMemoryServer } from './server.js'

await createMemoryServer(loadConfig()).connect(new StdioServerTransport())

export type { McpConfig } from './config.js'
export { V3MemoryClient, type V3ClientConfig } from './client.js'
