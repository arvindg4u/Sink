#!/usr/bin/env node
import type { CommandDef } from 'citty'
import type { ExitCode } from './errors.js'
import { mainCommand } from './commands/index.js'
import { ApiError, CliError, EXIT_CODES, toError } from './errors.js'
import { configureOutput, fail, printLine } from './output.js'
import { resolveCommandPath } from './usage.js'
import { VERSION } from './version.js'

interface ErrorWithCode {
  code?: unknown
}

function isCittyCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as ErrorWithCode).code === code
}

/**
 * citty decides whether to colour its usage output when the module is first
 * evaluated, so the policy has to be applied before it is imported — hence the
 * dynamic import in `main`. Explicit flags win; otherwise colour follows the
 * usual `NO_COLOR`/TTY rules.
 */
function applyUsageColorPolicy(argv: readonly string[]): void {
  const env = process.env
  if (env.NO_COLOR === '1' || env.TERM === 'dumb' || env.TEST !== undefined || env.CI !== undefined) {
    return
  }
  if (argv.includes('--no-color')) {
    env.NO_COLOR = '1'
    return
  }
  if (argv.includes('--color')) {
    return
  }
  if (process.stdout.isTTY !== true) {
    env.NO_COLOR = '1'
  }
}

/** Make sure error output respects `--no-color` even when no command ran. */
function configureErrorOutput(rawArgs: readonly string[]): void {
  configureOutput({ color: rawArgs.includes('--no-color') ? false : undefined })
}

async function handleError(error: unknown, rawArgs: readonly string[]): Promise<ExitCode> {
  const { showUsage } = await import('citty')
  configureErrorOutput(rawArgs)

  if (isCittyCode(error, 'E_NO_COMMAND') || isCittyCode(error, 'E_UNKNOWN_COMMAND')) {
    const target = await resolveCommandPath(mainCommand, rawArgs)
    if (isCittyCode(error, 'E_UNKNOWN_COMMAND')) {
      fail(toError(error).message)
    }
    await showUsage(target.command, target.parent)
    return EXIT_CODES.usage
  }

  if (error instanceof ApiError) {
    fail(error.message)
    for (const detail of error.details) {
      fail(`  ${detail}`)
    }
    return error.exitCode
  }

  if (error instanceof CliError) {
    fail(error.message)
    return error.exitCode
  }

  const cause = toError(error)
  fail(cause.message)
  if (process.env.SINK_DEBUG !== undefined && process.env.SINK_DEBUG !== '') {
    process.stderr.write(`${cause.stack ?? ''}\n`)
  }
  return EXIT_CODES.failure
}

async function main(argv: readonly string[]): Promise<ExitCode> {
  applyUsageColorPolicy(argv)
  const { runCommand, showUsage } = await import('citty')

  if (argv.includes('--help') || argv.includes('-h')) {
    const target = await resolveCommandPath(mainCommand, argv)
    await showUsage(target.command, target.parent)
    return EXIT_CODES.ok
  }

  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    printLine(VERSION)
    return EXIT_CODES.ok
  }

  if (argv.length === 0) {
    await showUsage(mainCommand)
    return EXIT_CODES.usage
  }

  try {
    await runCommand(mainCommand as CommandDef, { rawArgs: [...argv] })
    return EXIT_CODES.ok
  }
  catch (error) {
    return await handleError(error, argv)
  }
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== EXIT_CODES.ok) {
      process.exitCode = code
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(`unexpected failure: ${toError(error).message}\n`)
    process.exitCode = EXIT_CODES.failure
  })
