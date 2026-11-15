import type { ArgsDef, CommandDef } from 'citty'
import type { McpListToolsResult } from '../api-types.js'
import type { SinkClient } from '../client.js'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createProxyServerFactory } from '../mcp/proxy.js'
import { emptyNotice, fail, notice, printJson, printTable } from '../output.js'
import { VERSION } from '../version.js'
import { clientFor, defineSinkCommand, GLOBAL_ARGS } from './args.js'

const CLIENT_INFO = { name: '@sink/cli', version: VERSION }

/**
 * Read the instance's own MCP instructions so the proxy advertises the same
 * guidance as calling the endpoint directly. Best effort: a failure here only
 * means the proxy starts without instructions.
 */
async function readRemoteInstructions(client: SinkClient): Promise<string | undefined> {
  try {
    const result = await client.jsonRpc<{ instructions?: string }>('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    return typeof result.instructions === 'string' ? result.instructions : undefined
  }
  catch {
    return undefined
  }
}

const serveCommand = defineSinkCommand({
  meta: { name: 'serve', description: 'Serve MCP over stdio, proxying to the configured Sink instance' },
  args: {
    ...GLOBAL_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const instructions = await readRemoteInstructions(client)
    const factory = createProxyServerFactory({
      client,
      name: 'sink',
      title: 'Sink',
      version: VERSION,
      instructions,
    })

    // Everything on stdout belongs to the JSON-RPC channel, so the readiness
    // banner goes to stderr (see the MCP stdio guidance).
    const handle = serveStdio(factory, {
      onerror: error => fail(`mcp: ${error.message}`),
    })
    notice(`mcp server listening on stdio -> ${client.url}`)

    const shutdown = (): void => {
      void handle.close()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  },
})

const toolsCommand = defineSinkCommand({
  meta: { name: 'tools', description: 'List the MCP tools exposed by the configured instance' },
  args: {
    ...GLOBAL_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const result = await client.jsonRpc<McpListToolsResult>('tools/list', {})

    if (args.json === true) {
      printJson(result)
      return
    }
    if (result.tools.length === 0) {
      emptyNotice('mcp tools')
      return
    }
    printTable(result.tools, [
      { header: 'tool', value: tool => tool.name, color: 'cyan' },
      { header: 'title', value: tool => tool.title ?? '' },
      { header: 'description', value: tool => tool.description ?? '', maxWidth: 80 },
    ])
  },
})

export const mcpCommand: CommandDef = {
  meta: { name: 'mcp', description: 'Model Context Protocol integration' },
  args: GLOBAL_ARGS,
  subCommands: {
    serve: serveCommand,
    tools: toolsCommand,
  },
}
