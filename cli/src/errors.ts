/**
 * Exit codes are part of the CLI's contract: shell scripts branch on them.
 * `0` is reserved for a fully successful run.
 */
export const EXIT_CODES = {
  /** The command completed successfully. */
  ok: 0,
  /** The API refused the request or the command could not complete. */
  failure: 1,
  /** The command line itself was wrong (unknown flag, missing argument). */
  usage: 2,
  /** No usable profile/configuration was found. */
  config: 3,
  /** The configured Sink instance could not be reached. */
  network: 4,
} as const

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]

/** Base class for every expected, user-facing failure. */
export class CliError extends Error {
  readonly exitCode: ExitCode

  constructor(message: string, exitCode: ExitCode = EXIT_CODES.failure, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

/** Invalid invocation: unknown command, missing or contradictory flags. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_CODES.usage)
    this.name = 'UsageError'
  }
}

/** Missing or malformed configuration/profile. */
export class ConfigError extends CliError {
  constructor(message: string) {
    super(message, EXIT_CODES.config)
    this.name = 'ConfigError'
  }
}

/** Transport-level failure: DNS, TLS, timeout, connection reset. */
export class NetworkError extends CliError {
  readonly url: string

  constructor(message: string, url: string, options?: { cause?: unknown }) {
    super(message, EXIT_CODES.network, options)
    this.name = 'NetworkError'
    this.url = url
  }
}

/** The Sink instance answered with a non-2xx status. */
export class ApiError extends CliError {
  readonly status: number
  readonly url: string
  readonly details: string[]

  constructor(message: string, status: number, url: string, details: string[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.url = url
    this.details = details
  }
}

/** Narrow an unknown thrown value to an Error without losing the original. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Map anything thrown by a command to a process exit code. */
export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof CliError) {
    return error.exitCode
  }
  return EXIT_CODES.failure
}
