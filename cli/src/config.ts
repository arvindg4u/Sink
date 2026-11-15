import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConfigError } from './errors.js'

export interface SinkProfile {
  /** Base URL of the Sink instance, without a trailing slash. */
  url: string
  /** Bearer token issued by that instance. */
  token: string
}

export interface SinkConfig {
  defaultProfile: string
  profiles: Record<string, SinkProfile>
}

const EMPTY_CONFIG: SinkConfig = { defaultProfile: '', profiles: {} }

/** Config directory, honouring `XDG_CONFIG_HOME` when it is set. */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config')
  return join(base, 'sink')
}

export function configPath(): string {
  return join(configDir(), 'config.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalise a base URL: keep the path, drop trailing slashes. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function parseProfile(name: string, value: unknown): SinkProfile {
  if (!isRecord(value)) {
    throw new ConfigError(`Profile "${name}" in ${configPath()} is not an object.`)
  }
  const url = typeof value.url === 'string' ? normalizeUrl(value.url) : ''
  const token = typeof value.token === 'string' ? value.token.trim() : ''
  if (url === '') {
    throw new ConfigError(`Profile "${name}" in ${configPath()} is missing "url".`)
  }
  if (token === '') {
    throw new ConfigError(`Profile "${name}" in ${configPath()} is missing "token".`)
  }
  return { url, token }
}

/** Read the config file; a missing file yields an empty config. */
export function readConfig(): SinkConfig {
  const path = configPath()
  if (!existsSync(path)) {
    return { ...EMPTY_CONFIG, profiles: {} }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  }
  catch (error) {
    throw new ConfigError(`Could not read ${path}: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`)
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object.`)
  }

  const profiles: Record<string, SinkProfile> = {}
  const rawProfiles = parsed.profiles
  if (rawProfiles !== undefined) {
    if (!isRecord(rawProfiles)) {
      throw new ConfigError(`${path}: "profiles" must be an object.`)
    }
    for (const [name, value] of Object.entries(rawProfiles)) {
      profiles[name] = parseProfile(name, value)
    }
  }

  const defaultProfile = typeof parsed.defaultProfile === 'string' ? parsed.defaultProfile : ''
  return { defaultProfile, profiles }
}

/**
 * Persist the config file.
 *
 * The file holds bearer tokens, so it is created with mode `600` and the
 * directory with `700`. `chmodSync` covers the case where the file already
 * existed with looser permissions.
 */
export function writeConfig(config: SinkConfig): string {
  const path = configPath()
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  const payload = `${JSON.stringify(config, null, 2)}\n`
  writeFileSync(path, payload, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export interface ResolvedProfile {
  /** Profile name, or `null` when the URL and token came from the environment. */
  name: string | null
  url: string
  token: string
  /** Where the effective URL and token came from, for `sink profiles list`. */
  source: 'environment' | 'profile'
}

/** Environment variables that override the stored configuration. */
export interface ProfileEnv {
  SINK_PROFILE?: string
  SINK_URL?: string
  SINK_TOKEN?: string
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined
}

export const PROFILE_HINT = 'Run "sink profiles add <name> --url <url> --token <token>" or export SINK_URL and SINK_TOKEN.'

/**
 * Resolve the effective instance, applying the documented precedence:
 * explicit `--profile` > `SINK_PROFILE` > `config.defaultProfile`, then
 * `SINK_URL`/`SINK_TOKEN` on top of the selected profile.
 */
export function resolveProfile(explicitProfile?: string, env: ProfileEnv = process.env): ResolvedProfile {
  const config = readConfig()
  const envUrl = nonEmpty(env.SINK_URL)
  const envToken = nonEmpty(env.SINK_TOKEN)

  const name = nonEmpty(explicitProfile) ?? nonEmpty(env.SINK_PROFILE) ?? nonEmpty(config.defaultProfile) ?? null
  const profile = name !== null ? config.profiles[name] : undefined

  if (name !== null && profile === undefined && envUrl === undefined) {
    const known = Object.keys(config.profiles).sort()
    const suffix = known.length > 0 ? ` Known profiles: ${known.join(', ')}.` : ''
    throw new ConfigError(`Unknown profile "${name}".${suffix} ${PROFILE_HINT}`)
  }

  const url = envUrl ?? profile?.url
  const token = envToken ?? profile?.token

  if (url === undefined) {
    throw new ConfigError(`No Sink instance configured. ${PROFILE_HINT}`)
  }
  if (token === undefined) {
    const scope = envToken === undefined && profile !== undefined ? ` for profile "${name}"` : ''
    throw new ConfigError(`No bearer token configured${scope}. ${PROFILE_HINT}`)
  }

  const source: ResolvedProfile['source'] = envUrl !== undefined || envToken !== undefined ? 'environment' : 'profile'
  return { name, url: normalizeUrl(url), token, source }
}

/** Redact a token for display: keep a short prefix so profiles stay distinguishable. */
export function maskToken(token: string): string {
  if (token.length <= 8) {
    return '*'.repeat(token.length)
  }
  return `${token.slice(0, 4)}…${'*'.repeat(6)}`
}
