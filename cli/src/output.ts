import type { Writable } from 'node:stream'

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  gray: '\u001B[90m',
} as const

export type ColorName = keyof typeof ANSI

export interface OutputState {
  /** Emit raw JSON on stdout instead of a human-readable table. */
  json: boolean
  /** Emit machine-friendly, decoration-free output (tab separated, no headers). */
  quiet: boolean
  /** Whether ANSI escapes are written. */
  color: boolean
}

let state: OutputState = { json: false, quiet: false, color: false }

export interface ConfigureOutputOptions {
  json?: boolean
  quiet?: boolean
  /** `true` forces colour on, `false` forces it off, `undefined` auto-detects. */
  color?: boolean
  stdout?: Writable & { isTTY?: boolean }
}

/**
 * Resolve the output mode once per invocation.
 *
 * Colour precedence: explicit flag > `FORCE_COLOR` > `NO_COLOR` > TTY detection.
 * `--json` never emits colour so the output stays pipe-safe.
 */
export function configureOutput(options: ConfigureOutputOptions = {}): OutputState {
  const stdout = options.stdout ?? process.stdout
  const json = options.json === true
  const quiet = options.quiet === true
  state = { json, quiet, color: resolveColor(options.color, json, stdout) }
  return state
}

function resolveColor(explicit: boolean | undefined, json: boolean, stdout: { isTTY?: boolean }): boolean {
  if (json) {
    return false
  }
  if (explicit !== undefined) {
    return explicit
  }
  const force = process.env.FORCE_COLOR
  if (force !== undefined && force !== '' && force !== '0') {
    return true
  }
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false
  }
  if (process.env.TERM === 'dumb') {
    return false
  }
  return stdout.isTTY === true
}

export function getOutputState(): OutputState {
  return state
}

export function colorize(name: ColorName, text: string): string {
  return state.color ? `${ANSI[name]}${text}${ANSI.reset}` : text
}

/** Remove the `ESC[…m` sequences this module emits so widths are measured on visible characters. */
function stripAnsi(text: string): string {
  const ESCAPE = 0x1B
  let result = ''
  let index = 0
  while (index < text.length) {
    if (text.charCodeAt(index) === ESCAPE && text[index + 1] === '[') {
      index += 2
      while (index < text.length && text[index] !== 'm') {
        index += 1
      }
      index += 1
      continue
    }
    result += text[index]
    index += 1
  }
  return result
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length
}

export function write(text: string): void {
  process.stdout.write(text)
}

export function printLine(text = ''): void {
  process.stdout.write(`${text}\n`)
}

/** Pretty-printed JSON on stdout, the `--json` output mode. */
export function printJson(value: unknown): void {
  printLine(JSON.stringify(value, null, 2))
}

/** Diagnostics always go to stderr so stdout stays pipeable. */
function printStderr(text: string): void {
  process.stderr.write(`${text}\n`)
}

export function warn(message: string): void {
  printStderr(`${colorize('yellow', 'warn')} ${message}`)
}

export function fail(message: string): void {
  printStderr(`${colorize('red', 'error')} ${message}`)
}

/** Progress/confirmation notices; suppressed by `--quiet`. */
export function notice(message: string): void {
  if (state.quiet) {
    return
  }
  printStderr(`${colorize('dim', message)}`)
}

export interface TableColumn<T> {
  header: string
  /** Column value as plain text; colour is applied by the renderer. */
  value: (row: T) => string
  align?: 'left' | 'right'
  /** Hard cap on the rendered width; longer values are ellipsised. */
  maxWidth?: number
  /** Colour applied to the cell text. */
  color?: ColorName
}

export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || text.length <= maxWidth) {
    return text
  }
  if (maxWidth === 1) {
    return '…'
  }
  return `${text.slice(0, maxWidth - 1)}…`
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const missing = width - visibleLength(text)
  const filler = missing > 0 ? ' '.repeat(missing) : ''
  return align === 'right' ? `${filler}${text}` : `${text}${filler}`
}

/**
 * Column-aligned table sized to its content.
 *
 * `--quiet` degrades to tab-separated values without a header so the same
 * command can feed `cut`/`awk`.
 */
export function printTable<T>(rows: readonly T[], columns: readonly TableColumn<T>[]): void {
  if (state.quiet) {
    for (const row of rows) {
      printLine(columns.map(column => truncate(column.value(row), column.maxWidth ?? Number.POSITIVE_INFINITY)).join('\t'))
    }
    return
  }

  const cells = rows.map(row => columns.map(column => truncate(column.value(row), column.maxWidth ?? Number.POSITIVE_INFINITY)))
  const widths = columns.map((column, index) =>
    Math.max(visibleLength(column.header), ...cells.map(row => (row[index] ?? '').length), 0),
  )

  const header = columns.map((column, index) => pad(colorize('bold', column.header.toUpperCase()), widths[index] ?? 0, column.align ?? 'left'))
  printLine(header.join('  ').trimEnd())

  for (const row of cells) {
    const line = row
      .map((cell, index) => {
        const column = columns[index]
        const painted = column?.color ? colorize(column.color, cell) : cell
        return pad(painted, widths[index] ?? 0, column?.align ?? 'left')
      })
      .join('  ')
    printLine(line.trimEnd())
  }
}

export interface RecordEntry {
  key: string
  value: string
  color?: ColorName
}

/** Render a single object as an aligned `key  value` block. */
export function printRecord(entries: readonly RecordEntry[]): void {
  if (state.quiet) {
    for (const entry of entries) {
      printLine(`${entry.key}\t${entry.value}`)
    }
    return
  }

  const width = entries.reduce((max, entry) => Math.max(max, entry.key.length), 0)
  for (const entry of entries) {
    const key = colorize('dim', entry.key.padEnd(width))
    const value = entry.color ? colorize(entry.color, entry.value) : entry.value
    printLine(`${key}  ${value}`)
  }
}

export function emptyNotice(command: string): void {
  notice(`${command}: no results`)
}
