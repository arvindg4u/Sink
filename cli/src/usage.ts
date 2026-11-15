import type { ArgsDef, CommandDef, Resolvable, SubCommandsDef } from 'citty'

/** Mirror of citty's internal `resolveValue`. */
async function resolveValue<T>(value: Resolvable<T>): Promise<T> {
  if (typeof value === 'function') {
    return await (value as () => T | Promise<T>)()
  }
  return await value
}

function camelCase(value: string): string {
  return value.replace(/-(\w)/g, (_, char: string) => char.toUpperCase())
}

/** True when `flag` is a string/enum option that consumes the next argv token. */
async function isValueFlag(flag: string, argsDef: ArgsDef): Promise<boolean> {
  const name = flag.replace(/^-{1,2}/, '')
  const normalized = camelCase(name)
  for (const [key, def] of Object.entries(argsDef)) {
    if (def.type !== 'string' && def.type !== 'enum') {
      continue
    }
    if (normalized === camelCase(key)) {
      return true
    }
    const aliases = Array.isArray(def.alias) ? def.alias : def.alias !== undefined ? [def.alias] : []
    if (aliases.includes(name)) {
      return true
    }
  }
  return false
}

/** Index of the first positional token, skipping flag values. Mirrors citty. */
async function findSubCommandIndex(rawArgs: readonly string[], argsDef: ArgsDef): Promise<number> {
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index] ?? ''
    if (arg === '--') {
      return -1
    }
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && await isValueFlag(arg, argsDef)) {
        index += 1
      }
      continue
    }
    return index
  }
  return -1
}

async function findSubCommand(subCommands: SubCommandsDef, name: string): Promise<CommandDef | undefined> {
  const direct = subCommands[name]
  if (direct !== undefined) {
    return await resolveValue(direct)
  }
  for (const entry of Object.values(subCommands)) {
    const resolved = await resolveValue(entry)
    const meta = resolved.meta === undefined ? undefined : await resolveValue(resolved.meta)
    const alias = meta?.alias
    if (alias !== undefined && (Array.isArray(alias) ? alias.includes(name) : alias === name)) {
      return resolved
    }
  }
  return undefined
}

export interface CommandPath {
  command: CommandDef
  parent?: CommandDef
  /** Command names from the root down, e.g. `['sink', 'links', 'create']`. */
  names: string[]
}

/**
 * Walk the command tree the way citty would, so `--help` and usage errors
 * print the help for the command the user actually asked about.
 */
export async function resolveCommandPath(root: CommandDef, rawArgs: readonly string[]): Promise<CommandPath> {
  const args = rawArgs.filter(arg => arg !== '--help' && arg !== '-h')
  let command = root
  let rest = args
  const names: string[] = []

  for (;;) {
    const meta = command.meta === undefined ? undefined : await resolveValue(command.meta)
    names.push(meta?.name ?? 'sink')

    const subCommands = command.subCommands === undefined ? undefined : await resolveValue(command.subCommands)
    if (subCommands === undefined || Object.keys(subCommands).length === 0) {
      break
    }

    const argsDef = command.args === undefined ? {} : await resolveValue(command.args)
    const index = await findSubCommandIndex(rest, argsDef)
    if (index === -1) {
      break
    }
    const next = await findSubCommand(subCommands, rest[index] ?? '')
    if (next === undefined) {
      break
    }
    command = next
    rest = rest.slice(index + 1)
  }

  if (names.length === 1) {
    return { command, names }
  }
  // citty renders `<parent> <command>`; feed it the joined path so deep
  // commands read as `sink links create` rather than `links create`.
  return { command, parent: { meta: { name: names.slice(0, -1).join(' ') } }, names }
}
