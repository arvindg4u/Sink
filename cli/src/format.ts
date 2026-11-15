import { UsageError } from './errors.js'

/** Render unix seconds as a compact UTC timestamp, e.g. `2026-11-15 05:12:37Z`. */
export function formatTimestamp(seconds: number | undefined | null): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return '—'
  }
  return `${new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19)}Z`
}

/** Render unix seconds as the remaining lifetime, e.g. `in 12d` / `expired`. */
export function formatExpiry(seconds: number | undefined | null, now = Date.now()): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 'never'
  }
  const deltaSeconds = Math.round(seconds - now / 1000)
  if (deltaSeconds <= 0) {
    return 'expired'
  }
  const units: Array<[label: string, size: number]> = [['d', 86_400], ['h', 3_600], ['m', 60]]
  for (const [label, size] of units) {
    if (deltaSeconds >= size) {
      return `in ${Math.floor(deltaSeconds / size)}${label}`
    }
  }
  return `in ${deltaSeconds}s`
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

/**
 * Parse a comma-separated flag into a trimmed, de-duplicated list.
 * Returns `undefined` when the flag was not supplied so the caller can omit it.
 */
export function parseList(value: string | undefined, flag: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  const items = value.split(',').map(item => item.trim()).filter(item => item !== '')
  if (items.length === 0) {
    throw new UsageError(`--${flag} was provided but is empty. Pass a comma-separated list of values.`)
  }
  return uniqueSorted(items)
}

/** Parse repeated `CODE=url` pairs into a geo routing map. */
export function parseGeo(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined
  }
  const geo: Record<string, string> = {}
  for (const entry of value.split(',').map(item => item.trim()).filter(item => item !== '')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      throw new UsageError(`--geo entry "${entry}" is not in CODE=url form, e.g. --geo US=https://example.com`)
    }
    const code = entry.slice(0, separator).trim().toUpperCase()
    const target = entry.slice(separator + 1).trim()
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new UsageError(`--geo country code "${code}" must be two letters, e.g. US`)
    }
    if (target === '') {
      throw new UsageError(`--geo entry for ${code} has no URL.`)
    }
    geo[code] = target
  }
  return Object.keys(geo).length > 0 ? geo : undefined
}

/** Parse an integer flag, rejecting non-numeric and out-of-range values. */
export function parseInteger(value: string | undefined, flag: string, bounds: { min?: number, max?: number } = {}): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new UsageError(`--${flag} must be an integer, received "${value}".`)
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new UsageError(`--${flag} must be at least ${bounds.min}.`)
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new UsageError(`--${flag} must be at most ${bounds.max}.`)
  }
  return parsed
}

/** Accept unix seconds or an ISO-8601 date and return unix seconds. */
export function parseTimestamp(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed)
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    throw new UsageError(`--${flag} must be unix seconds or an ISO-8601 date, received "${value}".`)
  }
  return Math.floor(parsed / 1000)
}
