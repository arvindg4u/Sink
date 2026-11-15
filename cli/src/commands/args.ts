import type { ArgsDef, CommandContext, CommandDef } from 'citty'
import type { QueryInput, SinkClient } from '../client.js'
import type { ResolvedProfile } from '../config.js'
import { SinkClient as Client } from '../client.js'
import { resolveProfile } from '../config.js'
import { UsageError } from '../errors.js'
import { parseGeo, parseInteger, parseList, parseTimestamp } from '../format.js'
import { configureOutput } from '../output.js'

/** Flags every command accepts. */
export const GLOBAL_ARGS = {
  profile: {
    type: 'string',
    description: 'Profile to use; overrides SINK_PROFILE and the config default',
    valueHint: 'name',
  },
  json: {
    type: 'boolean',
    description: 'Print the raw API response as JSON on stdout',
    default: false,
  },
  quiet: {
    type: 'boolean',
    description: 'Print machine-friendly output: tab separated, no headers, no notices',
    default: false,
  },
  color: {
    type: 'boolean',
    description: 'Force ANSI colour',
    negativeDescription: 'Disable ANSI colour',
  },
  timeout: {
    type: 'string',
    description: 'Request timeout in seconds',
    valueHint: 'seconds',
    default: '30',
  },
} satisfies ArgsDef

/** Writable link fields shared by create/update/upsert. */
export const LINK_FIELD_ARGS = {
  'url': { type: 'string', description: 'Target URL', valueHint: 'url' },
  'slug': { type: 'string', description: 'Slug identifying the short link', valueHint: 'slug' },
  'comment': { type: 'string', description: 'Internal note', valueHint: 'text' },
  'expiration': {
    type: 'string',
    description: 'Expiry as unix seconds or an ISO-8601 date (create/update require a future time)',
    valueHint: 'time',
  },
  'title': { type: 'string', description: 'Preview title override', valueHint: 'text' },
  'description': { type: 'string', description: 'Preview description override', valueHint: 'text' },
  'image': { type: 'string', description: 'Preview image override', valueHint: 'url' },
  'apple': { type: 'string', description: 'App Store redirect URL', valueHint: 'url' },
  'google': { type: 'string', description: 'Play Store redirect URL', valueHint: 'url' },
  'cloaking': { type: 'boolean', description: 'Mask the destination behind the short link' },
  'redirect-with-query': { type: 'boolean', description: 'Append incoming query parameters to the destination' },
  'proxy': { type: 'boolean', description: 'Reverse-proxy the destination instead of redirecting' },
  'password': { type: 'string', description: 'Password protection; an empty string clears it on update', valueHint: 'secret' },
  'unsafe': { type: 'boolean', description: 'Show a warning page before redirecting' },
  'geo': {
    type: 'string',
    description: 'Geo routing as CODE=url pairs, e.g. US=https://example.com,DE=https://example.de',
    valueHint: 'pairs',
  },
  'tags': { type: 'string', description: 'Comma-separated tags, at most 10', valueHint: 'list' },
} satisfies ArgsDef

/** Access-log filters accepted by every analytics command. */
export const FILTER_ARGS = {
  'id': { type: 'string', description: 'Filter by access-log id', valueHint: 'id' },
  'start-at': { type: 'string', description: 'Start of the window: unix seconds or an ISO-8601 date', valueHint: 'time' },
  'end-at': { type: 'string', description: 'End of the window: unix seconds or an ISO-8601 date', valueHint: 'time' },
  'slug': { type: 'string', description: 'Filter by slug (comma-separated list)', valueHint: 'list' },
  'url': { type: 'string', description: 'Filter by target URL (comma-separated list)', valueHint: 'list' },
  'referer': { type: 'string', description: 'Filter by referer (comma-separated list)', valueHint: 'list' },
  'country': { type: 'string', description: 'Filter by country (comma-separated list)', valueHint: 'list' },
  'region': { type: 'string', description: 'Filter by region (comma-separated list)', valueHint: 'list' },
  'city': { type: 'string', description: 'Filter by city (comma-separated list)', valueHint: 'list' },
  'timezone': { type: 'string', description: 'Filter by timezone (comma-separated list)', valueHint: 'list' },
  'language': { type: 'string', description: 'Filter by language (comma-separated list)', valueHint: 'list' },
  'os': { type: 'string', description: 'Filter by operating system (comma-separated list)', valueHint: 'list' },
  'browser': { type: 'string', description: 'Filter by browser (comma-separated list)', valueHint: 'list' },
  'browser-type': { type: 'string', description: 'Filter by browser type (comma-separated list)', valueHint: 'list' },
  'device': { type: 'string', description: 'Filter by device (comma-separated list)', valueHint: 'list' },
  'device-type': { type: 'string', description: 'Filter by device type (comma-separated list)', valueHint: 'list' },
} satisfies ArgsDef

/** Link filters accepted by list/search/count/export. */
export const LINK_FILTER_ARGS = {
  tag: { type: 'string', description: 'Exact tag filter (normalised to lowercase)', valueHint: 'tag' },
  status: {
    type: 'enum',
    description: 'Expiration status filter',
    options: ['active', 'expired', 'all'],
  },
} satisfies ArgsDef

type Flags = Record<string, unknown>

interface OutputFlags {
  json?: boolean
  quiet?: boolean
  color?: boolean
}

/**
 * Wrap a command so the output mode is configured from its own parsed flags
 * before the handler runs. citty only executes the selected command's `run`,
 * so this is the one place that needs to know about `--json`/`--quiet`/`--color`.
 */
export function defineSinkCommand<const T extends ArgsDef>(def: CommandDef<T>): CommandDef<T> {
  const baseRun = def.run
  if (baseRun === undefined) {
    return def
  }
  return {
    ...def,
    run: (context: CommandContext<T>) => {
      const flags = context.args as OutputFlags
      configureOutput({ json: flags.json === true, quiet: flags.quiet === true, color: flags.color })
      return baseRun(context)
    },
  }
}

/** Build an authenticated client for the resolved profile. */
export function clientFor(args: Flags): SinkClient {
  const { client } = clientAndProfile(args)
  return client
}

export function clientAndProfile(args: Flags): { client: SinkClient, profile: ResolvedProfile } {
  const seconds = parseInteger(args.timeout as string | undefined, 'timeout', { min: 1, max: 600 }) ?? 30
  const profile = resolveProfile(args.profile as string | undefined)
  const client = new Client({ url: profile.url, token: profile.token, timeoutMs: seconds * 1000 })
  return { client, profile }
}

/** Require a positional argument, falling back to a flag of the same name. */
export function requireValue(flagValue: unknown, positional: unknown, label: string): string {
  const value = typeof flagValue === 'string' && flagValue !== ''
    ? flagValue
    : typeof positional === 'string' && positional !== ''
      ? positional
      : undefined
  if (value === undefined) {
    throw new UsageError(`Missing required argument <${label}>. Run "sink --help" for usage.`)
  }
  return value
}

/** Build the writable link payload from parsed flags. */
export function buildLinkBody(args: Flags): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const strings = ['url', 'slug', 'comment', 'title', 'description', 'image', 'apple', 'google'] as const
  for (const key of strings) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') {
      body[key] = value
    }
  }

  // The API treats an absent boolean and `false` identically for both create
  // and edit, so booleans are always sent explicitly.
  body.cloaking = args.cloaking === true
  body.redirectWithQuery = args.redirectWithQuery === true
  body.proxy = args.proxy === true
  body.unsafe = args.unsafe === true

  const expiration = parseTimestamp(args.expiration as string | undefined, 'expiration')
  if (expiration !== undefined) {
    body.expiration = expiration
  }

  const tags = parseList(args.tags as string | undefined, 'tags')
  if (tags !== undefined) {
    body.tags = tags
  }

  const geo = parseGeo(args.geo as string | undefined)
  if (geo !== undefined) {
    body.geo = geo
  }

  const password = args.password
  if (typeof password === 'string') {
    body.password = password
  }

  return body
}

/** Build the shared access-log filter query for analytics commands. */
export function buildFilterQuery(args: Flags): QueryInput {
  const query: QueryInput = {}
  const passthrough = [
    'id',
  ] as const
  for (const key of passthrough) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') {
      query[key] = value
    }
  }

  const comma = [
    'slug',
    'url',
    'referer',
    'country',
    'region',
    'city',
    'timezone',
    'language',
    'os',
    'browser',
    'browserType',
    'device',
    'deviceType',
  ] as const
  for (const key of comma) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') {
      query[key] = parseList(value, key)
    }
  }

  const startAt = parseTimestamp(args.startAt as string | undefined, 'start-at')
  if (startAt !== undefined) {
    query.startAt = startAt
  }
  const endAt = parseTimestamp(args.endAt as string | undefined, 'end-at')
  if (endAt !== undefined) {
    query.endAt = endAt
  }

  if (query.startAt !== undefined && query.endAt !== undefined && (query.startAt as number) > (query.endAt as number)) {
    throw new UsageError('--start-at must not be later than --end-at.')
  }

  return query
}

export type { CommandContext, CommandDef }
