import type { CallToolResult, ListToolsResult, Server, ServerOptions } from '@modelcontextprotocol/server'
import type { SinkClient } from '../client.js'
import { Server as McpServer } from '@modelcontextprotocol/server'

export interface McpProxyConfig {
  client: SinkClient
  name: string
  title?: string
  version: string
  instructions?: string
}

/**
 * Build an MCP server factory that forwards `tools/list` and `tools/call` to
 * the remote Sink instance.
 *
 * Proxying at the protocol level (instead of re-declaring every tool locally)
 * keeps the tool names, descriptions and input schemas in lockstep with
 * whatever the instance actually exposes.
 */
export function createProxyServerFactory(config: McpProxyConfig): () => Server {
  return () => {
    const options: ServerOptions = { capabilities: { tools: {} } }
    if (config.instructions !== undefined) {
      options.instructions = config.instructions
    }

    const server = new McpServer({ name: config.name, version: config.version, title: config.title }, options)

    server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => {
      return await config.client.jsonRpc<ListToolsResult>('tools/list', {})
    })

    server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
      const params = request.params
      return await config.client.jsonRpc<CallToolResult>('tools/call', {
        name: params.name,
        arguments: params.arguments ?? {},
      })
    })

    return server
  }
}
