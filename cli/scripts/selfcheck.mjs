// End-to-end check of the built CLI against a local stub of the Sink API.
//
// Nothing here touches a real instance: a throwaway HTTP server replays the
// response shapes captured from a live Sink deployment (including the MCP
// JSON-RPC endpoint), which lets us assert tables, JSON mode, quiet mode,
// exit codes and the `mcp serve` stdio proxy without network access.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const entry = join(root, 'dist', 'cli.js')

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail === '' ? '' : ` :: ${detail}`}`)
}

const links = new Map()
const MCP_INSTRUCTIONS = 'Stub instance for the CLI self-check.'

function readBody(request) {
  return new Promise((resolve) => {
    let raw = ''
    request.on('data', chunk => (raw += chunk))
    request.on('end', () => resolve(raw))
  })
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const send = (status, payload) => {
    const body = payload === undefined ? '' : JSON.stringify(payload)
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body)
  }

  if (url.pathname === '/api/mcp') {
    const message = JSON.parse((await readBody(request)) || '{}')
    const results = {
      'initialize': {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'sink', title: 'Sink', version: '0.3.1' },
        instructions: MCP_INSTRUCTIONS,
      },
      'tools/list': {
        tools: [
          {
            name: 'list_tags',
            title: 'List tags',
            description: 'List every tag currently in use.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
      'tools/call': { content: [{ type: 'text', text: '[{"name":"alpha","count":1}]' }] },
    }
    const result = results[message.method]
    if (result === undefined) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n\n`)
      return
    }
    // Sink answers MCP over Streamable HTTP with an SSE frame.
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
    return
  }

  if (url.pathname === '/api/verify') {
    send(200, { name: 'Sink', authMethod: 'site-token', userID: 'root' })
    return
  }
  if (url.pathname === '/api/link/list') {
    send(200, { links: [...links.values()], list_complete: true })
    return
  }
  if (url.pathname === '/api/link/count') {
    send(200, { count: links.size })
    return
  }
  if (url.pathname === '/api/link/query') {
    const link = links.get(url.searchParams.get('slug') ?? '')
    if (link === undefined) {
      send(404, { error: true, statusCode: 404, statusMessage: 'Not Found', message: '' })
      return
    }
    send(200, link)
    return
  }
  if (url.pathname === '/api/link/create') {
    const body = JSON.parse((await readBody(request)) || '{}')
    const link = { ...body, slug: body.slug ?? 'generated', id: 'stub', createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }
    links.set(link.slug, link)
    send(200, { link, shortLink: `http://localhost/${link.slug}` })
    return
  }
  if (url.pathname === '/api/link/delete') {
    const body = JSON.parse((await readBody(request)) || '{}')
    links.delete(body.slug)
    response.writeHead(204)
    response.end()
    return
  }
  if (url.pathname === '/api/link/tags') {
    send(200, [{ name: 'alpha', count: 1 }])
    return
  }
  if (url.pathname === '/api/stats/counters') {
    send(200, { data: [{ visits: 3, visitors: 2, referers: 1 }] })
    return
  }
  send(404, { error: true, statusCode: 404, statusMessage: 'Not Found', message: '' })
})

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

/** Drive `sink mcp serve` over stdio with a minimal JSON-RPC client. */
function mcpSession(env) {
  const child = spawn(process.execPath, [entry, 'mcp', 'serve'], {
    env: { ...process.env, NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const waiters = new Map()
  let buffer = ''
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += chunk))
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line === '') {
        continue
      }
      let message
      try {
        message = JSON.parse(line)
      }
      catch {
        continue
      }
      const waiter = waiters.get(message.id)
      if (waiter !== undefined) {
        waiters.delete(message.id)
        waiter(message)
      }
    }
  })

  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`timed out waiting for ${method}`))
      }, 10_000)
      waiters.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

  return {
    child,
    request,
    notify,
    stderr: () => stderr,
  }
}

const configHome = mkdtempSync(join(tmpdir(), 'sink-cli-cfg-'))

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
const env = { SINK_URL: baseUrl, SINK_TOKEN: 'stub-token-value', XDG_CONFIG_HOME: configHome }

try {
  const help = await run(['--help'], env)
  check('--help exits 0', help.code === 0, `exit ${help.code}`)
  check('--help lists links', help.stdout.includes('links'))
  check('--help renders without colour when piped', !help.stdout.includes('\u001B['))

  const version = await run(['--version'], env)
  check('--version prints a version', /^\d+\.\d+\.\d+$/.test(version.stdout.trim()), version.stdout.trim())

  const created = await run(['links', 'create', '--url', 'https://example.com', '--slug', 'demo'], env)
  check('create prints the short link', created.stdout.trim() === 'http://localhost/demo', created.stdout.trim())
  check('create exits 0', created.code === 0)

  const json = await run(['links', 'create', '--url', 'https://example.com/second', '--slug', 'demo-2', '--json'], env)
  check('create --json emits JSON', JSON.parse(json.stdout).link.slug === 'demo-2')

  const list = await run(['links', 'list'], env)
  check('list renders a header', list.stdout.includes('SLUG') && list.stdout.includes('URL'))
  check('list contains both rows', list.stdout.includes('demo') && list.stdout.includes('demo-2'))

  const quiet = await run(['links', 'list', '--quiet'], env)
  check('list --quiet drops the header', !quiet.stdout.includes('SLUG'))
  check('list --quiet is tab separated', quiet.stdout.trim().split('\n').every(line => line.includes('\t')))

  const coloured = await run(['links', 'list', '--color'], env)
  check('--color forces ANSI escapes', coloured.stdout.includes('\u001B['))

  const count = await run(['links', 'count'], env)
  check('count prints a bare number', count.stdout.trim() === '2', count.stdout.trim())

  const record = await run(['links', 'get', 'demo'], env)
  check('get renders key/value rows', record.stdout.includes('slug') && record.stdout.includes('demo'))

  const removed = await run(['links', 'delete', 'demo'], env)
  check('delete exits 0', removed.code === 0, removed.stderr)
  const afterDelete = await run(['links', 'count'], env)
  check('delete removed the link', afterDelete.stdout.trim() === '1', afterDelete.stdout.trim())

  const missing = await run(['links', 'get', 'ghost'], env)
  check('unknown slug exits 1', missing.code === 1, `exit ${missing.code}`)
  check('unknown slug reports the status', missing.stderr.includes('404 Not Found'), missing.stderr)

  const badUsage = await run(['links', 'create', '--slug', 'no-url'], env)
  check('missing --url is a usage error', badUsage.code === 2, `exit ${badUsage.code}`)

  const unknown = await run(['links', 'bogus'], env)
  check('unknown sub-command exits 2', unknown.code === 2, `exit ${unknown.code}`)

  const noProfile = await run(['links', 'list'], { SINK_URL: undefined, SINK_TOKEN: undefined })
  check('missing config exits 3', noProfile.code === 3, `exit ${noProfile.code}`)

  const unreachable = await run(['links', 'list'], { SINK_URL: 'http://127.0.0.1:9', SINK_TOKEN: 'stub-token-value' })
  check('unreachable host exits 4', unreachable.code === 4, `exit ${unreachable.code}`)

  const addProfile = await run(['profiles', 'add', 'local', '--url', baseUrl, '--token', 'stub-token-value', '--use'], env)
  check('profiles add exits 0', addProfile.code === 0, addProfile.stderr)
  const configFile = join(configHome, 'sink', 'config.json')
  check('config file is mode 600', (statSync(configFile).mode & 0o777) === 0o600, (statSync(configFile).mode & 0o777).toString(8))
  check('config stores the profile', JSON.parse(readFileSync(configFile, 'utf8')).profiles.local.url === baseUrl)

  const viaProfile = await run(['verify'], { XDG_CONFIG_HOME: configHome, SINK_URL: undefined, SINK_TOKEN: undefined })
  check('resolves the stored profile', viaProfile.stdout.includes('root'), viaProfile.stdout + viaProfile.stderr)

  const counters = await run(['stats', 'counters'], env)
  check('stats counters renders values', counters.stdout.includes('visits') && counters.stdout.includes('3'))

  const mcpTools = await run(['mcp', 'tools'], env)
  check('mcp tools lists the remote tools', mcpTools.stdout.includes('list_tags'), mcpTools.stdout + mcpTools.stderr)

  const session = mcpSession(env)
  try {
    const init = await session.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'selfcheck', version: '1.0.0' },
    })
    check('mcp serve answers initialize', init.result?.serverInfo?.name === 'sink', JSON.stringify(init))
    check('mcp serve forwards server instructions', init.result?.instructions === MCP_INSTRUCTIONS, JSON.stringify(init.result?.instructions))
    session.notify('notifications/initialized')
    const tools = await session.request(2, 'tools/list', {})
    check('mcp serve proxies tools/list', tools.result?.tools?.[0]?.name === 'list_tags', JSON.stringify(tools))
    const call = await session.request(3, 'tools/call', { name: 'list_tags', arguments: {} })
    check('mcp serve proxies tools/call', call.result?.content?.[0]?.text?.includes('alpha') === true, JSON.stringify(call))
    check('mcp serve keeps stdout free of banners', !session.stderr().includes('\n{'), session.stderr())
  }
  finally {
    session.child.stdin.end()
    session.child.kill()
  }

  const entrySource = readFileSync(entry, 'utf8')
  check('entry point keeps its shebang', entrySource.startsWith('#!/usr/bin/env node'))
  check('entry point is executable', (statSync(entry).mode & 0o111) !== 0)
}
finally {
  server.close()
  rmSync(configHome, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
