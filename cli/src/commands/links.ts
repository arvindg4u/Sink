import type { ArgsDef, CommandDef } from 'citty'
import type {
  CheckResponse,
  CheckResult,
  CountResponse,
  ExportDocument,
  ImportResult,
  LinkListResponse,
  LinkWriteResponse,
  MigrationRunResult,
  MigrationStatus,
  SinkLink,
  TagCount,
} from '../api-types.js'
import type { QueryInput } from '../client.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { UsageError } from '../errors.js'
import { formatExpiry, formatTimestamp, parseInteger } from '../format.js'
import { emptyNotice, notice, printJson, printLine, printRecord, printTable, warn } from '../output.js'
import { buildLinkBody, clientFor, defineSinkCommand, GLOBAL_ARGS, LINK_FIELD_ARGS, LINK_FILTER_ARGS, requireValue } from './args.js'

const MAX_PAGES = 200

function linkColumns() {
  return [
    { header: 'slug', value: (link: SinkLink) => link.slug, color: 'cyan' as const },
    { header: 'url', value: (link: SinkLink) => link.url, maxWidth: 60 },
    { header: 'tags', value: (link: SinkLink) => (link.tags ?? []).join(','), maxWidth: 30 },
    { header: 'expires', value: (link: SinkLink) => formatExpiry(link.expiration) },
    { header: 'created', value: (link: SinkLink) => formatTimestamp(link.createdAt) },
  ]
}

interface Page {
  cursor?: string
  list_complete?: boolean
}

/** Fetch one page, or every page when `all` is set. */
async function collectPages<T extends Page>(
  fetchPage: (cursor?: string) => Promise<T>,
  all: boolean,
): Promise<T[]> {
  const pages: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchPage(cursor)
    pages.push(response)
    if (!all || response.list_complete !== false || response.cursor === undefined) {
      break
    }
    cursor = response.cursor
  }
  if (all && pages.length === MAX_PAGES) {
    warn(`Stopped after ${MAX_PAGES} pages; narrow the query to fetch the rest.`)
  }
  return pages
}

function mergeLinks(pages: readonly LinkListResponse[]): SinkLink[] {
  return pages.flatMap(page => page.links)
}

function shortLinkFor(response: LinkWriteResponse, baseUrl: string): string {
  return response.shortLink ?? `${baseUrl.replace(/\/+$/, '')}/${response.link.slug}`
}

function linkFilterQuery(args: { tag?: string, status?: string }): QueryInput {
  return { tag: args.tag, status: args.status }
}

const listCommand = defineSinkCommand({
  meta: { name: 'list', description: 'List short links, newest first' },
  args: {
    ...GLOBAL_ARGS,
    ...LINK_FILTER_ARGS,
    limit: { type: 'string', description: 'Maximum links per page (1-1000)', valueHint: 'count', default: '20' },
    cursor: { type: 'string', description: 'Pagination cursor from a previous run', valueHint: 'cursor' },
    sort: {
      type: 'enum',
      description: 'Sort order',
      options: ['az', 'za', 'newest', 'oldest'],
      default: 'newest',
    },
    all: { type: 'boolean', description: 'Follow pagination and print every matching link', default: false },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const limit = parseInteger(args.limit, 'limit', { min: 1, max: 1000 }) ?? 20
    const pages = await collectPages(
      (cursor?: string) => client.get<LinkListResponse>('/api/link/list', {
        ...linkFilterQuery(args),
        limit,
        sort: args.sort,
        cursor: cursor ?? args.cursor,
      }),
      args.all === true,
    )

    if (args.json === true) {
      printJson(pages.length === 1 ? pages[0] : pages)
      return
    }

    const links = mergeLinks(pages)
    if (links.length === 0) {
      emptyNotice('links list')
      return
    }
    printTable(links, linkColumns())

    const first = pages[0]
    if (args.all !== true && first !== undefined && first.list_complete !== true && first.cursor !== undefined) {
      notice(`more results available; continue with --cursor ${first.cursor}`)
    }
  },
})

function printLinkRecord(link: SinkLink): void {
  const rows: Array<{ key: string, value: string, color?: 'green' | 'yellow' }> = [
    { key: 'slug', value: link.slug },
    { key: 'url', value: link.url },
    { key: 'comment', value: link.comment ?? '' },
    { key: 'tags', value: (link.tags ?? []).join(',') },
    {
      key: 'expiration',
      value: link.expiration === undefined
        ? 'never'
        : `${formatTimestamp(link.expiration)} (${formatExpiry(link.expiration)})`,
    },
  ]

  const booleanRows = ['cloaking', 'proxy', 'redirectWithQuery', 'unsafe'] as const
  for (const key of booleanRows) {
    rows.push({ key, value: String(link[key] === true) })
  }

  if (link.title !== undefined) {
    rows.push({ key: 'title', value: link.title })
  }
  if (link.image !== undefined) {
    rows.push({ key: 'image', value: link.image })
  }
  if (link.geo !== undefined) {
    rows.push({ key: 'geo', value: Object.entries(link.geo).map(([code, url]) => `${code}=${url}`).join(',') })
  }

  rows.push({ key: 'createdAt', value: formatTimestamp(link.createdAt) })
  rows.push({ key: 'updatedAt', value: formatTimestamp(link.updatedAt) })
  rows.push({ key: 'id', value: link.id ?? '' })

  printRecord(rows)
}

const getCommand = defineSinkCommand({
  meta: { name: 'get', description: 'Read a single link by slug' },
  args: {
    ...GLOBAL_ARGS,
    slug: { type: 'positional', description: 'Slug of the link to read', required: true },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const slug = requireValue(args.slug, args._[0], 'slug')
    const link = await client.get<SinkLink>('/api/link/query', { slug })

    if (args.json === true) {
      printJson(link)
      return
    }
    printLinkRecord(link)
  },
})

const createCommand = defineSinkCommand({
  meta: { name: 'create', description: 'Create a short link; fails when the slug is taken' },
  args: {
    ...GLOBAL_ARGS,
    ...LINK_FIELD_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const body = buildLinkBody(args)
    if (typeof body.url !== 'string') {
      throw new UsageError('--url is required. Example: sink links create --url https://example.com')
    }
    const client = clientFor(args)
    const response = await client.post<LinkWriteResponse>('/api/link/create', body)

    if (args.json === true) {
      printJson(response)
      return
    }
    printLine(shortLinkFor(response, client.url))
  },
})

const upsertCommand = defineSinkCommand({
  meta: { name: 'upsert', description: 'Create the link when absent, otherwise return the existing one' },
  args: {
    ...GLOBAL_ARGS,
    ...LINK_FIELD_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const body = buildLinkBody(args)
    if (typeof body.url !== 'string') {
      throw new UsageError('--url is required. Example: sink links upsert --url https://example.com --slug demo')
    }
    const client = clientFor(args)
    const response = await client.post<LinkWriteResponse & { created?: boolean }>('/api/link/upsert', body)

    if (args.json === true) {
      printJson(response)
      return
    }
    printLine(shortLinkFor(response, client.url))
  },
})

const updateCommand = defineSinkCommand({
  meta: { name: 'update', description: 'Replace a link by slug; omitted optional fields are cleared' },
  args: {
    ...GLOBAL_ARGS,
    ...LINK_FIELD_ARGS,
    slug: { type: 'positional', description: 'Slug of the link to replace', required: true },
  } satisfies ArgsDef,
  async run({ args }) {
    const slug = requireValue(undefined, args.slug ?? args._[0], 'slug')
    const body = buildLinkBody(args)
    body.slug = slug
    if (typeof body.url !== 'string') {
      throw new UsageError('--url is required. Example: sink links update demo --url https://example.com')
    }
    const client = clientFor(args)
    const response = await client.put<LinkWriteResponse>('/api/link/edit', body)

    if (args.json === true) {
      printJson(response)
      return
    }
    printLine(shortLinkFor(response, client.url))
  },
})

const deleteCommand = defineSinkCommand({
  meta: { name: 'delete', description: 'Permanently delete a link by slug' },
  args: {
    ...GLOBAL_ARGS,
    slug: { type: 'positional', description: 'Slug of the link to delete', required: true },
  } satisfies ArgsDef,
  async run({ args }) {
    const slug = requireValue(args.slug, args._[0], 'slug')
    const client = clientFor(args)
    await client.post<undefined>('/api/link/delete', { slug })

    if (args.json === true) {
      printJson({ slug, deleted: true })
      return
    }
    printLine(slug)
  },
})

const searchCommand = defineSinkCommand({
  meta: { name: 'search', description: 'Search links by keyword or exact destination URL' },
  args: {
    ...GLOBAL_ARGS,
    ...LINK_FILTER_ARGS,
    q: { type: 'string', description: 'Case-insensitive keyword matched against slug, URL, comment and tags', valueHint: 'text' },
    url: { type: 'string', description: 'Exact destination URL to match', valueHint: 'url' },
    limit: { type: 'string', description: 'Maximum matches (1-1000)', valueHint: 'count', default: '20' },
  } satisfies ArgsDef,
  async run({ args }) {
    if (args.q === undefined && args.url === undefined) {
      throw new UsageError('Pass --q <keyword> or --url <url>. Example: sink links search --q launch')
    }
    const client = clientFor(args)
    const limit = parseInteger(args.limit, 'limit', { min: 1, max: 1000 }) ?? 20
    const links = await client.get<SinkLink[]>('/api/link/search', {
      ...linkFilterQuery(args),
      q: args.q,
      url: args.url,
      limit,
    })

    if (args.json === true) {
      printJson(links)
      return
    }
    if (links.length === 0) {
      emptyNotice('links search')
      return
    }
    printTable(links, linkColumns())
  },
})

const countCommand = defineSinkCommand({
  meta: { name: 'count', description: 'Count links matching a keyword, URL, tag or status' },
  args: {
    ...GLOBAL_ARGS,
    ...LINK_FILTER_ARGS,
    q: { type: 'string', description: 'Case-insensitive keyword matched against slug, URL, comment and tags', valueHint: 'text' },
    url: { type: 'string', description: 'Exact destination URL to match', valueHint: 'url' },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const response = await client.get<CountResponse>('/api/link/count', {
      ...linkFilterQuery(args),
      q: args.q,
      url: args.url,
    })

    if (args.json === true) {
      printJson(response)
      return
    }
    printLine(String(response.count))
  },
})

const exportCommand = defineSinkCommand({
  meta: { name: 'export', description: 'Export links as a Sink import document' },
  args: {
    ...GLOBAL_ARGS,
    ...LINK_FILTER_ARGS,
    cursor: { type: 'string', description: 'Pagination cursor from a previous run', valueHint: 'cursor' },
    output: { type: 'string', description: 'Write the document to a file instead of stdout', valueHint: 'path' },
    all: { type: 'boolean', description: 'Follow pagination and export every matching link', default: true },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const pages = await collectPages(
      (cursor?: string) => client.get<ExportDocument>('/api/link/export', {
        status: args.status ?? 'all',
        cursor: cursor ?? args.cursor,
      }),
      args.all !== false,
    )

    const first = pages[0]
    const links = mergeLinks(pages)
    const document: ExportDocument = {
      version: first?.version ?? '1.0',
      exportedAt: first?.exportedAt ?? new Date().toISOString(),
      count: links.length,
      links,
    }

    if (args.json === true) {
      printLine(JSON.stringify(document))
      return
    }

    const payload = `${JSON.stringify(document, null, 2)}\n`
    if (args.output !== undefined) {
      writeFileSync(args.output, payload, { mode: 0o600 })
      notice(`exported ${document.count} link(s) to ${args.output}`)
      return
    }
    process.stdout.write(payload)
  },
})

const importCommand = defineSinkCommand({
  meta: { name: 'import', description: 'Import an export document produced by "sink links export"' },
  args: {
    ...GLOBAL_ARGS,
    file: { type: 'positional', description: 'Path to the export document, or - for stdin', required: true },
  } satisfies ArgsDef,
  async run({ args }) {
    const file = requireValue(args.file, args._[0], 'file')
    const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch (error) {
      throw new UsageError(`${file} is not valid JSON: ${(error as Error).message}`)
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as ExportDocument).links)) {
      throw new UsageError(`${file} must contain an object with a "links" array.`)
    }

    const client = clientFor(args)
    const result = await client.post<ImportResult>('/api/link/import', parsed)
    const imported = typeof result.imported === 'number' ? result.imported : (parsed as ExportDocument).links.length

    if (args.json === true) {
      printJson(result)
      return
    }
    printLine(String(imported))
    notice(result.message ?? (result.success === false ? 'import failed' : 'import complete'))
  },
})

const checkCommand = defineSinkCommand({
  meta: { name: 'check', description: 'Fetch each stored link and report its HTTP status' },
  args: {
    ...GLOBAL_ARGS,
    cursor: { type: 'string', description: 'Pagination cursor from a previous run', valueHint: 'cursor' },
    limit: { type: 'string', description: 'Links to check per page (1-10)', valueHint: 'count', default: '6' },
    timeout: { type: 'string', description: 'Timeout in seconds for each link check (1-30)', valueHint: 'seconds', default: '6' },
    all: { type: 'boolean', description: 'Follow pagination and check every link', default: false },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const limit = parseInteger(args.limit, 'limit', { min: 1, max: 10 }) ?? 6
    const timeout = parseInteger(args.timeout, 'timeout', { min: 1, max: 30 }) ?? 6
    const pages = await collectPages(
      (cursor?: string) => client.post<CheckResponse>('/api/link/check', { cursor: cursor ?? args.cursor, limit, timeout }),
      args.all === true,
    )

    if (args.json === true) {
      printJson(pages.length === 1 ? pages[0] : pages)
      return
    }

    const results: CheckResult[] = pages.flatMap(page => page.results)
    if (results.length === 0) {
      emptyNotice('links check')
      return
    }
    printTable(results, [
      { header: 'slug', value: result => result.slug, color: 'cyan' },
      { header: 'status', value: result => String(result.status ?? ''), align: 'right' },
      { header: 'ok', value: result => (result.ok === true ? 'yes' : 'no') },
      { header: 'ms', value: result => String(result.duration ?? ''), align: 'right' },
      { header: 'result', value: result => result.error ?? result.url, maxWidth: 60 },
    ])
  },
})

const tagsCommand = defineSinkCommand({
  meta: { name: 'tags', description: 'List tags in use with their link counts' },
  args: {
    ...GLOBAL_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const tags = await client.get<TagCount[]>('/api/link/tags')

    if (args.json === true) {
      printJson(tags)
      return
    }
    if (tags.length === 0) {
      emptyNotice('tags')
      return
    }
    printTable(tags, [
      { header: 'tag', value: tag => tag.name, color: 'cyan' },
      { header: 'links', value: tag => String(tag.count), align: 'right' },
    ])
  },
})

const aiCommand = defineSinkCommand({
  meta: { name: 'ai', description: 'Generate a slug for a URL with the instance AI helper' },
  args: {
    ...GLOBAL_ARGS,
    url: { type: 'positional', description: 'URL to generate a slug for', required: true },
  } satisfies ArgsDef,
  async run({ args }) {
    const url = requireValue(args.url, args._[0], 'url')
    const client = clientFor(args)
    const result = await client.get<{ slug: string }>('/api/link/ai', { url })

    if (args.json === true) {
      printJson(result)
      return
    }
    printLine(result.slug)
  },
})

const ogAiCommand = defineSinkCommand({
  meta: { name: 'og-ai', description: 'Generate OpenGraph metadata for a URL with the instance AI helper' },
  args: {
    ...GLOBAL_ARGS,
    url: { type: 'positional', description: 'URL to generate metadata for', required: true },
    locale: { type: 'string', description: 'Preferred locale for the generated metadata', valueHint: 'locale' },
  } satisfies ArgsDef,
  async run({ args }) {
    const url = requireValue(args.url, args._[0], 'url')
    const client = clientFor(args)
    const result = await client.get<Record<string, unknown>>('/api/link/og-ai', { url, locale: args.locale })

    if (args.json === true) {
      printJson(result)
      return
    }
    printRecord(Object.entries(result).map(([key, value]) => ({ key, value: String(value) })))
  },
})

const uploadCommand = defineSinkCommand({
  meta: { name: 'upload', description: 'Upload a link preview image, keyed by slug' },
  args: {
    ...GLOBAL_ARGS,
    file: { type: 'positional', description: 'Image file to upload', required: true },
    slug: { type: 'string', description: 'Slug the image belongs to', valueHint: 'slug' },
  } satisfies ArgsDef,
  async run({ args }) {
    const file = requireValue(args.file, args._[0], 'file')
    const slug = requireValue(args.slug, undefined, 'slug')
    const client = clientFor(args)
    const buffer = readFileSync(file)
    const form = new FormData()
    form.append('slug', slug)
    form.append('file', new Blob([buffer]), file.split('/').pop() ?? 'image')
    const result = await client.request<Record<string, unknown>>('POST', '/api/upload/image', { formData: form })

    if (args.json === true) {
      printJson(result)
      return
    }
    const key = result.key ?? result.url ?? result
    printLine(typeof key === 'string' ? key : JSON.stringify(key))
  },
})

const migrationStatusCommand = defineSinkCommand({
  meta: { name: 'status', description: 'Report the KV to D1 migration status' },
  args: {
    ...GLOBAL_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const status = await client.get<MigrationStatus>('/api/link/migration/status')

    if (args.json === true) {
      printJson(status)
      return
    }
    printRecord([
      { key: 'completed', value: String(status.completed), color: status.completed ? 'green' : 'yellow' },
      { key: 'marker', value: status.marker === undefined ? '' : JSON.stringify(status.marker) },
    ])
  },
})

const migrationRunCommand = defineSinkCommand({
  meta: { name: 'run', description: 'Run the KV to D1 migration' },
  args: {
    ...GLOBAL_ARGS,
    cursor: { type: 'string', description: 'Opaque migration cursor from a previous run', valueHint: 'cursor' },
    force: { type: 'boolean', description: 'Rescan KV without overwriting D1 rows', default: false },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const result = await client.post<MigrationRunResult>('/api/link/migration/run', {
      cursor: args.cursor,
      force: args.force === true,
    })

    if (args.json === true) {
      printJson(result)
      return
    }
    printRecord([
      { key: 'completed', value: String(result.completed) },
      { key: 'scanned', value: String(result.scanned) },
      { key: 'inserted', value: String(result.inserted) },
      { key: 'skipped', value: String(result.skipped) },
      { key: 'expired', value: String(result.expired) },
      { key: 'failed', value: String(result.failed), color: result.failed > 0 ? 'red' : undefined },
    ])
  },
})

const migrationCommand: CommandDef = {
  meta: { name: 'migration', description: 'KV to D1 migration helpers' },
  args: GLOBAL_ARGS,
  subCommands: {
    status: migrationStatusCommand,
    run: migrationRunCommand,
  },
}

export const linksCommand: CommandDef = {
  meta: { name: 'links', description: 'Create, read, update and inspect short links' },
  args: GLOBAL_ARGS,
  subCommands: {
    'list': listCommand,
    'get': getCommand,
    'create': createCommand,
    'update': updateCommand,
    'delete': deleteCommand,
    'upsert': upsertCommand,
    'search': searchCommand,
    'export': exportCommand,
    'import': importCommand,
    'check': checkCommand,
    'count': countCommand,
    'tags': tagsCommand,
    'ai': aiCommand,
    'og-ai': ogAiCommand,
    'upload': uploadCommand,
    'migration': migrationCommand,
  },
}

export { tagsCommand }
