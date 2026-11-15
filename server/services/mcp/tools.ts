import type { CallToolResult, McpServer, StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server'
import type { H3Event } from 'h3'
import { createError, isError } from 'h3'
import { z } from 'zod'
import { ImportDataSchema } from '#shared/schemas/import'
import {
  CreateLinkSchema,
  DeleteLinkSchema,
  EditLinkSchema,
  LinkFilterQuerySchema,
  LinkSlugQuerySchema,
  ListLinksQuerySchema,
  nanoid,
  SearchLinksQuerySchema,
  SlugSchema,
} from '#shared/schemas/link'
import { LinkCheckRequestSchema } from '#shared/schemas/link-check'
import { FilterQuerySchema } from '#shared/schemas/query'
import { IMAGE_ALLOWED_TYPES, IMAGE_MAX_SIZE } from '#shared/utils/image'
import { generateLinkOgMetadata, generateLinkSlug } from '../../utils/ai-generate'
import {
  buildCountersQuery,
  buildHeatmapQuery,
  buildMetricsQuery,
  buildViewsQuery,
  HeatmapQuerySchema,
  MetricsQuerySchema,
  ViewsQuerySchema,
} from '../../utils/analytics-queries'
import { backupLinksToR2 } from '../../utils/backup'
import { useWAE } from '../../utils/cloudflare'
import { bulkExportLinks, bulkImportLinks, ExportLinksQuerySchema } from '../../utils/link-bulk'
import { checkLinksPage } from '../../utils/link-check'
import { sanitizeLinkPassword, sanitizeLinksPassword } from '../../utils/link-password'
import { removeLink, replaceLink, saveNewLink, upsertLink } from '../../utils/link-processing'
import { countLinks, getLinkWithMetadata, listLinks, listTags, normalizeSlug, searchLinks } from '../../utils/link-store'
import { requireR2Bucket } from '../../utils/r2'
import { buildVerificationResponse } from '../../utils/verify'
import { assertLinkStoreReady, readCompletedLinkMigrationMarker } from '../link-store/migration'

interface McpToolDefinition {
  name: string
  description: string
  /**
   * The zod contract the SDK advertises verbatim and validates arguments
   * against before the callback runs, so the handler receives its parsed
   * output type and never re-parses.
   */
  inputSchema: StandardSchemaWithJSON
  annotations?: ToolAnnotations
  handler: (event: H3Event, args: unknown) => Promise<unknown>
}

/**
 * Types each tool's handler args as the output of its own input schema; the
 * SDK has already validated the value against that schema when it is passed
 * through, so the single cast is sound.
 */
function defineTool<S extends StandardSchemaWithJSON>(tool: Omit<McpToolDefinition, 'inputSchema' | 'handler'> & {
  inputSchema: S
  handler: (event: H3Event, args: StandardSchemaWithJSON.InferOutput<S>) => Promise<unknown>
}): McpToolDefinition {
  return { ...tool, handler: (event, args) => tool.handler(event, args as StandardSchemaWithJSON.InferOutput<S>) }
}

const FILTER_NOTE = 'Every filter accepts a comma-separated list of values.'

/** Tools reaching the link store, which the REST routes gate through middleware. */
const linkTools: McpToolDefinition[] = [
  defineTool({
    name: 'list_links',
    description: 'List short links newest first, with cursor pagination. Use search_links when looking for a specific link.',
    inputSchema: ListLinksQuerySchema,
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      const list = await listLinks(event, args)
      return { ...list, links: sanitizeLinksPassword(list.links) }
    },
  }),
  defineTool({
    name: 'search_links',
    description: 'Search links by keyword or exact destination URL. One of `q` or `url` is required; without either the result is empty.',
    inputSchema: SearchLinksQuerySchema,
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      const links = args.q || args.url ? await searchLinks(event, args) : []
      return { links }
    },
  }),
  defineTool({
    name: 'get_link',
    description: 'Read a single short link by slug, including its stored metadata.',
    inputSchema: LinkSlugQuerySchema,
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      const { link, metadata } = await getLinkWithMetadata(event, normalizeSlug(event, args.slug))
      if (!link)
        throw createError({ status: 404, statusText: 'Link not found' })

      return sanitizeLinkPassword({ ...metadata, ...link })
    },
  }),
  defineTool({
    name: 'count_links',
    description: 'Count links matching an optional keyword, URL, tag, or expiration status.',
    inputSchema: LinkFilterQuerySchema,
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      return { count: await countLinks(event, args) }
    },
  }),
  defineTool({
    name: 'list_tags',
    description: 'List every tag currently in use, with the number of links carrying it.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    async handler(event) {
      return { tags: await listTags(event) }
    },
  }),
  defineTool({
    name: 'check_links',
    description: 'Fetch the target URL of each stored link, alphabetically by slug with cursor pagination, and report its HTTP status. URLs that are not public HTTP(S) are skipped with an error.',
    inputSchema: LinkCheckRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler(event, args) {
      return checkLinksPage(event, args)
    },
  }),
  defineTool({
    name: 'create_link',
    description: 'Create a short link. Fails when the slug is already taken; use upsert_link to reuse an existing link instead.',
    inputSchema: CreateLinkSchema,
    annotations: { destructiveHint: false, idempotentHint: false },
    handler(event, args) {
      return saveNewLink(event, args)
    },
  }),
  defineTool({
    name: 'update_link',
    description: 'Replace an existing link identified by slug. Every writable field is overwritten and any omitted optional field is cleared, so read the link with get_link first and send it back complete. An empty password clears protection while an omitted one keeps it.',
    inputSchema: EditLinkSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
    handler(event, args) {
      return replaceLink(event, args)
    },
  }),
  defineTool({
    name: 'upsert_link',
    description: 'Return the existing link for a slug, or create it when absent. The result reports whether it was `created` or `existing`.',
    inputSchema: CreateLinkSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
    handler(event, args) {
      return upsertLink(event, args)
    },
  }),
  defineTool({
    name: 'delete_link',
    description: 'Permanently delete a short link. Existing traffic to the slug stops resolving immediately.',
    inputSchema: DeleteLinkSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
    async handler(event, args) {
      await removeLink(event, args.slug)
      return { slug: args.slug, deleted: true }
    },
  }),
  defineTool({
    name: 'import_links',
    description: 'Import links from an export payload. A slug that already exists is skipped rather than overwritten, so re-importing the same export is safe. Reports per-link success, skipped, and failed counts with the reason for each failure.',
    inputSchema: ImportDataSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
    handler(event, args) {
      return bulkImportLinks(event, args)
    },
  }),
  defineTool({
    name: 'export_links',
    description: 'Export stored links page by page, newest first, with password protection masked. Follow the returned `cursor` for the next page; `list_complete` marks the last one.',
    inputSchema: ExportLinksQuerySchema,
    annotations: { readOnlyHint: true },
    handler(event, args) {
      return bulkExportLinks(event, args)
    },
  }),
]

const analyticsTools: McpToolDefinition[] = [
  defineTool({
    name: 'get_analytics_counters',
    description: `Total visits, unique visitors, and referer counts over the access log. ${FILTER_NOTE}`,
    inputSchema: FilterQuerySchema,
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      return useWAE(event, buildCountersQuery(args, event))
    },
  }),
  defineTool({
    name: 'get_analytics_views',
    description: `Visits and visitors bucketed over time by minute, hour, or day. ${FILTER_NOTE}`,
    inputSchema: ViewsQuerySchema,
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      return useWAE(event, buildViewsQuery(args, event))
    },
  }),
  defineTool({
    name: 'get_analytics_metrics',
    description: `Top values for one access-log dimension, ordered by visits. ${FILTER_NOTE}`,
    inputSchema: MetricsQuerySchema,
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      return useWAE(event, buildMetricsQuery(args, event))
    },
  }),
  defineTool({
    name: 'get_analytics_heatmap',
    description: `Visits and visitors bucketed by weekday and hour of day in the given timezone. ${FILTER_NOTE}`,
    inputSchema: HeatmapQuerySchema,
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      return useWAE(event, buildHeatmapQuery(args, event))
    },
  }),
]

/** Decodes a base64 image payload, rejecting anything that is not valid base64. */
function decodeBase64Image(value: string): Uint8Array {
  let binary: string
  try {
    binary = atob(value)
  }
  catch {
    throw createError({ status: 400, statusText: 'contentBase64 is not valid base64' })
  }

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Tools that reach the link store only indirectly, or not at all. The REST
 * equivalents live outside the link-store middleware gate, so these are not
 * registered as link tools and stay callable while the KV-to-D1 migration is
 * pending — `migration_status` in particular must answer in that state.
 */
const utilityTools: McpToolDefinition[] = [
  defineTool({
    name: 'generate_slug',
    description: 'Ask Workers AI for a short slug derived from the page at a URL. Falls back to a slug built from the URL path when the model fails or returns nothing, so it always answers. Requires Workers AI to be bound.',
    inputSchema: z.object({
      url: z.url().describe('The URL to generate a slug for.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler(event, args) {
      return generateLinkSlug(event, args.url)
    },
  }),
  defineTool({
    name: 'generate_og_metadata',
    description: 'Ask Workers AI for a link-preview title and description read from the page at a URL, in the requested locale when the model supports it. Falls back to hostname-derived metadata. Requires Workers AI to be bound.',
    inputSchema: z.object({
      url: z.url().describe('The URL to generate preview metadata for.'),
      locale: z.string().optional().describe('Preferred locale for the generated text, for example en or zh-CN.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler(event, args) {
      return generateLinkOgMetadata(event, args.url, args.locale)
    },
  }),
  defineTool({
    name: 'upload_image',
    description: `Store an image in R2 for use as a link preview image, and return the /_assets/... URL to pass to create_link or update_link. Supply the bytes as base64. Allowed types: ${IMAGE_ALLOWED_TYPES.join(', ')}, up to 5 MB. Requires the R2 binding.`,
    inputSchema: z.object({
      slug: SlugSchema.describe('Slug of the link this image belongs to.'),
      filename: z.string().trim().min(1).max(255).describe('Original file name, used only for reporting.'),
      contentType: z.string()
        .refine(
          (value): boolean => (IMAGE_ALLOWED_TYPES as readonly string[]).includes(value),
          { message: `Unsupported image type. Allowed: ${IMAGE_ALLOWED_TYPES.join(', ')}` },
        )
        .describe(`MIME type of the image, one of: ${IMAGE_ALLOWED_TYPES.join(', ')}.`),
      contentBase64: z.string().min(1).describe('Base64-encoded image bytes.'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    async handler(event, args) {
      const R2 = requireR2Bucket(event.context.cloudflare.env)
      const bytes = decodeBase64Image(args.contentBase64)

      if (bytes.byteLength > IMAGE_MAX_SIZE) {
        throw createError({ status: 400, statusText: 'File size exceeds 5MB limit' })
      }

      const ext = args.contentType.split('/')[1]
      const key = `images/${args.slug}/${nanoid(10)()}.${ext}`

      await R2.put(key, bytes, {
        httpMetadata: {
          contentType: args.contentType,
        },
      })

      return { url: `/_assets/${key}`, key, filename: args.filename }
    },
  }),
  defineTool({
    name: 'backup_links',
    description: 'Write a full snapshot of every stored link to R2 and report completion. Requires the R2 binding, and fails while the one-time KV-to-D1 link migration is still pending.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: true },
    async handler(event) {
      const env = event.context.cloudflare.env
      const result = await backupLinksToR2(env, true)
      if (!result.completed && result.reason === 'migration-incomplete')
        throw createError({ status: 423, statusText: 'Link migration is required' })
      if (!result.completed)
        requireR2Bucket(env)

      return {
        success: true,
        message: 'Backup completed successfully',
      }
    },
  }),
  defineTool({
    name: 'migration_status',
    description: 'Report whether the one-time KV-to-D1 link migration has completed. Every link tool refuses with 423 until it has, so call this first when those fail.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    async handler(event) {
      const marker = await readCompletedLinkMigrationMarker(event.context.cloudflare.env)
      return {
        completed: marker !== null,
        marker,
      }
    },
  }),
  defineTool({
    name: 'verify',
    description: 'Report which credential this connection is using and which identity it resolves to. Useful as a cheap connectivity check before a longer sequence of calls.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    async handler(event) {
      return buildVerificationResponse(event)
    },
  }),
]

const linkToolNames = new Set(linkTools.map(tool => tool.name))

/** Explicit 4xx business errors reach the model verbatim; anything else is logged once and reported generically. */
function toolErrorText(toolName: string, error: unknown): string {
  if (isError(error)) {
    const statusCode = error.statusCode ?? 500
    if (statusCode < 500)
      return `${toolName} failed: ${statusCode} ${error.statusMessage || error.message}`
  }
  console.error(`MCP tool ${toolName} failed`, error)
  return `${toolName} failed: internal error`
}

/**
 * Registers the curated Sink tools on an SDK `McpServer`. The server is created
 * per request so each tool closes over its own `H3Event`; the SDK advertises the
 * zod contracts directly and validates arguments before the callback runs, so
 * handlers receive the parsed output. Business failures are returned with
 * `isError` so the calling model can self-correct.
 */
export function registerMcpTools(server: McpServer, event: H3Event): void {
  for (const tool of [...linkTools, ...analyticsTools, ...utilityTools]) {
    server.registerTool(tool.name, {
      // Titles are the display form of the name (`list_links` → `List links`),
      // and annotations fall back to the hints every Sink tool shares.
      title: tool.name.replace(/_/g, ' ').replace(/^./, character => character.toUpperCase()),
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: false, openWorldHint: false, ...tool.annotations },
    }, async (args): Promise<CallToolResult> => {
      try {
        if (linkToolNames.has(tool.name))
          await assertLinkStoreReady(event)

        const data = await tool.handler(event, args)
        // The payload also ships as `structuredContent`, so the text block stays
        // compact; it exists for clients that predate structured results.
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      }
      catch (error) {
        return { content: [{ type: 'text', text: toolErrorText(tool.name, error) }], isError: true }
      }
    })
  }
}
