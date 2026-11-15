/**
 * Programmatic surface of `@sink/cli`.
 *
 * The package's primary interface is the `sink` binary; this module exposes
 * the client and configuration helpers for scripts that need the same
 * behaviour without shelling out.
 */
export type {
  CheckResponse,
  CheckResult,
  CountResponse,
  ExportDocument,
  LinkListResponse,
  LinkWriteResponse,
  SinkLink,
  StatsEnvelope,
  TagCount,
  VerifyResponse,
} from './api-types.js'
export type { QueryInput, QueryValue, SinkClientOptions } from './client.js'
export { SinkClient } from './client.js'
export type { ProfileEnv, ResolvedProfile, SinkConfig, SinkProfile } from './config.js'
export {
  configDir,
  configPath,
  maskToken,
  normalizeUrl,
  readConfig,
  resolveProfile,
  writeConfig,
} from './config.js'
export {
  ApiError,
  CliError,
  ConfigError,
  EXIT_CODES,
  NetworkError,
  UsageError,
} from './errors.js'
export { VERSION } from './version.js'
