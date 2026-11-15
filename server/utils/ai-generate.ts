import type { H3Event } from 'h3'
import type { AiChatResponse } from './ai'
import { createError } from 'h3'
import { parseAiResponse } from './ai'
import { normalizeSlug } from './link-store'
import { fetchPageMarkdown } from './markdown'

/**
 * Slug and OpenGraph generation, extracted from the REST routes so the MCP
 * tools call the same implementation instead of a divergent copy. Both
 * surfaces must answer identically for the same URL.
 */

/** Derives a slug from the URL path when Workers AI is unavailable or unsure. */
function fallbackSlug(event: H3Event, url: string): string {
  let source = 'link'

  try {
    const urlObj = new URL(url)
    const pathSegments = urlObj.pathname.split('/').filter(Boolean)
    source = pathSegments.at(-1) ?? urlObj.hostname
  }
  catch {
    source = 'link'
  }

  const sanitizedSlug = source
    .replace(/[^A-Z0-9-]/gi, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '') || 'link'

  return normalizeSlug(event, sanitizedSlug)
}

export async function generateLinkSlug(event: H3Event, url: string): Promise<{ slug: string }> {
  const { AI } = event.context.cloudflare.env

  if (!AI) {
    throw createError({ status: 501, statusText: 'AI not enabled' })
  }

  const { aiPrompt, aiModel } = useRuntimeConfig(event)
  const { slugRegex } = useAppConfig()

  const markdown = await fetchPageMarkdown(event, url, AI)
  const userContent = markdown
    ? `URL: ${url}\n\nPage content:\n${markdown}`
    : url

  const messages = [
    { role: 'system', content: aiPrompt.replace('{slugRegex}', slugRegex.toString()) },

    { role: 'user', content: 'https://www.cloudflare.com/' },
    { role: 'assistant', content: '{"slug": "cloudflare"}' },

    { role: 'user', content: 'https://github.com/nuxt/' },
    { role: 'assistant', content: '{"slug": "nuxt"}' },

    { role: 'user', content: 'https://sink.cool/' },
    { role: 'assistant', content: '{"slug": "sink-cool"}' },

    { role: 'user', content: 'https://github.com/miantiao-me/sink' },
    { role: 'assistant', content: '{"slug": "sink"}' },

    { role: 'user', content: userContent },
  ]

  let response: AiChatResponse
  try {
    // @ts-expect-error Workers AI supports model-specific chat template options at runtime.
    response = await AI.run(aiModel as keyof AiModels, {
      messages,
      chat_template_kwargs: {
        enable_thinking: false,
        thinking: false,
      },
    }) as AiChatResponse
  }
  catch (error) {
    console.warn('Workers AI slug generation failed; using fallback.', error)
    return { slug: fallbackSlug(event, url) }
  }

  const result = parseAiResponse(response)
  const slug = String(result.slug ?? '').trim()
  if (!slug) {
    return { slug: fallbackSlug(event, url) }
  }

  return {
    slug: normalizeSlug(event, slug),
  }
}

/** Hostname-derived metadata used when Workers AI is unavailable or unsure. */
function fallbackOgMetadata(url: string): { title: string, description: string } {
  try {
    const { hostname } = new URL(url)

    return {
      title: hostname.replace(/^www\./, ''),
      description: `Short link for ${url}`,
    }
  }
  catch {
    return {
      title: 'Short Link',
      description: 'Check out this link on Sink.',
    }
  }
}

function resolveOgMetadataLocale(event: H3Event, locale?: string): string {
  const value = locale?.trim()
  if (!value) {
    return resolveRedirectLocale(event)
  }

  try {
    return Intl.getCanonicalLocales(value)[0] || resolveRedirectLocale(event)
  }
  catch {
    return resolveRedirectLocale(event)
  }
}

export async function generateLinkOgMetadata(
  event: H3Event,
  url: string,
  locale?: string,
): Promise<{ title: string, description: string }> {
  const { AI } = event.context.cloudflare.env

  if (!AI) {
    throw createError({ status: 501, statusText: 'AI not enabled' })
  }

  const { aiOgPrompt, aiModel } = useRuntimeConfig(event)
  const resolvedLocale = resolveOgMetadataLocale(event, locale)

  const markdown = await fetchPageMarkdown(event, url, AI)
  const userContent = markdown
    ? `URL: ${url}\n\nPage content:\n${markdown}`
    : url

  const messages = [
    { role: 'system', content: `${aiOgPrompt}\nGenerate the title and description in the language matching this locale: ${resolvedLocale}.` },

    { role: 'user', content: 'https://www.cloudflare.com/' },
    { role: 'assistant', content: '{"title": "Cloudflare", "description": "Cloudflare is a global network designed to make everything you connect to the Internet secure, private, fast, and reliable."}' },

    { role: 'user', content: 'https://github.com/nuxt/' },
    { role: 'assistant', content: '{"title": "Nuxt", "description": "Nuxt is an intuitive and extensible Vue framework for creating modern web applications."}' },

    { role: 'user', content: userContent },
  ]

  let response: AiChatResponse
  try {
    // @ts-expect-error Workers AI supports model-specific chat template options at runtime.
    response = await AI.run(aiModel as keyof AiModels, {
      messages,
      chat_template_kwargs: {
        enable_thinking: false,
        thinking: false,
      },
    }) as AiChatResponse
  }
  catch (error) {
    console.warn('Workers AI metadata generation failed; using fallback.', error)
    return fallbackOgMetadata(url)
  }

  const fallback = fallbackOgMetadata(url)
  const result = parseAiResponse(response)

  const title = String(result.title ?? '').trim() || fallback.title
  const description = String(result.description ?? '').trim() || fallback.description

  return {
    title,
    description,
  }
}
