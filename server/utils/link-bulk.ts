import type { H3Event } from 'h3'
import type { ImportData, ImportResult } from '#shared/schemas/import'
import type { ExportData, Link } from '#shared/schemas/link'
import { createError } from 'h3'
import { z } from 'zod'
import { nanoid } from '#shared/schemas/link'
import { normalizeLinkPasswordForStorage, protectLinkPasswordForExport } from './link-password'
import { createLinks, listLinks, normalizeSlug } from './link-store'

/**
 * Bulk link import and export, shared by the REST routes and the MCP tools.
 * Kept in one place so both surfaces apply the same size limit, the same
 * write guard, and the same password handling.
 */

export const ExportLinksQuerySchema = z.object({
  cursor: z.string().trim().max(1024).optional(),
  status: z.enum(['active', 'expired', 'all']).default('all'),
})

// h3 errors carry their text in `statusMessage` while `message` stays empty.
function describeImportError(error: unknown): string {
  if (!(error instanceof Error))
    return 'Unknown error'
  return error.message || (error as { statusMessage?: string }).statusMessage || 'Unknown error'
}

export async function bulkImportLinks(event: H3Event, importData: ImportData): Promise<ImportResult> {
  assertLinkWritesAllowed(event, 'import')

  const { importRequestLimit } = useRuntimeConfig(event)
  if (importData.links.length > importRequestLimit) {
    throw createError({
      status: 400,
      statusText: `Too many links. Maximum ${importRequestLimit} links per request.`,
    })
  }

  const result: ImportResult = {
    success: 0,
    skipped: 0,
    failed: 0,
    successItems: [],
    skippedItems: [],
    failedItems: [],
  }

  const chunkSize = 4
  for (let offset = 0; offset < importData.links.length; offset += chunkSize) {
    const chunk = importData.links.slice(offset, offset + chunkSize)
    const prepared = await Promise.all(chunk.map(async (linkData, chunkIndex) => {
      const index = offset + chunkIndex

      try {
        const slug = normalizeSlug(event, linkData.slug)
        const now = Math.floor(Date.now() / 1000)
        const link = {
          ...linkData,
          id: linkData.id || nanoid(10)(),
          slug,
          createdAt: linkData.createdAt ?? now,
          updatedAt: linkData.updatedAt ?? now,
        }
        if (link.password)
          link.password = await normalizeLinkPasswordForStorage(link.password)
        return { index, linkData, link }
      }
      catch (error) {
        return { index, linkData, error }
      }
    }))

    const writable = prepared.filter(item => 'link' in item) as { index: number, linkData: ImportData['links'][number], link: Link }[]
    const writeResults = await createLinks(event, writable.map(item => item.link))
    let writeIndex = 0
    for (const item of prepared) {
      if ('error' in item) {
        result.failed++
        result.failedItems.push({ index: item.index, slug: item.linkData.slug, url: item.linkData.url, reason: describeImportError(item.error) })
        continue
      }

      const writeResult = writeResults[writeIndex++]!
      if ('error' in writeResult) {
        result.failed++
        result.failedItems.push({ index: item.index, slug: item.link.slug, url: item.linkData.url, reason: describeImportError(writeResult.error) })
      }
      else if (!writeResult.created) {
        result.skippedItems.push({ index: item.index, slug: item.link.slug, url: item.linkData.url })
        result.skipped++
      }
      else {
        result.successItems.push({ index: item.index, slug: item.link.slug, url: item.linkData.url })
        result.success++
      }
    }
  }

  return result
}

export async function bulkExportLinks(
  event: H3Event,
  query: z.infer<typeof ExportLinksQuerySchema>,
): Promise<ExportData> {
  const kvBatchLimit = useRuntimeConfig(event).public.kvBatchLimit as string
  const limit = +kvBatchLimit

  const list = await listLinks(event, { limit, cursor: query.cursor, status: query.status, backfillExpiration: true })
  const links: Link[] = []
  for (const link of list.links) {
    if (link) {
      links.push(await protectLinkPasswordForExport(link))
    }
  }

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    count: links.length,
    links,
    cursor: list.cursor,
    list_complete: list.list_complete,
  }
}
