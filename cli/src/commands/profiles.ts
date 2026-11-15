import type { ArgsDef, CommandDef } from 'citty'
import { chmodSync } from 'node:fs'
import { configPath, maskToken, normalizeUrl, readConfig, writeConfig } from '../config.js'
import { ConfigError, UsageError } from '../errors.js'
import { notice, printJson, printLine, printRecord, printTable } from '../output.js'
import { defineSinkCommand, GLOBAL_ARGS } from './args.js'

const addCommand = defineSinkCommand({
  meta: { name: 'add', description: 'Create or replace a profile and store it with mode 600' },
  args: {
    ...GLOBAL_ARGS,
    name: { type: 'positional', description: 'Profile name', required: true },
    url: { type: 'string', description: 'Base URL of the Sink instance', valueHint: 'url', required: true },
    token: { type: 'string', description: 'Bearer token issued by that instance', valueHint: 'token', required: true },
    use: { type: 'boolean', description: 'Also make this the default profile', default: false },
  } satisfies ArgsDef,
  async run({ args }) {
    const name = args.name !== '' ? args.name : args._[0]
    if (typeof name !== 'string' || name === '') {
      throw new UsageError('A profile name is required. Example: sink profiles add prod --url https://sink.example.com --token <token>')
    }
    const url = typeof args.url === 'string' && args.url !== '' ? normalizeUrl(args.url) : undefined
    if (url === undefined) {
      throw new UsageError('--url is required. Example: sink profiles add prod --url https://sink.example.com --token <token>')
    }
    const token = typeof args.token === 'string' && args.token !== '' ? args.token.trim() : undefined
    if (token === undefined) {
      throw new UsageError('--token is required. Example: sink profiles add prod --url https://sink.example.com --token <token>')
    }

    const config = readConfig()
    const replacing = config.profiles[name] !== undefined
    config.profiles[name] = { url, token }
    const makeDefault = args.use === true || config.defaultProfile === ''
    if (makeDefault) {
      config.defaultProfile = name
    }
    const path = writeConfig(config)
    // `writeConfig` already chmods; repeat here so a pre-existing file with
    // looser permissions is tightened even when nothing else changed.
    chmodSync(path, 0o600)

    if (args.json === true) {
      printJson({ name, url, defaultProfile: config.defaultProfile, path })
      return
    }
    printLine(name)
    notice(`${replacing ? 'updated' : 'added'} profile "${name}" in ${path}`)
    if (!makeDefault) {
      notice(`"${name}" is not the default profile; run "sink profiles use ${name}" to switch.`)
    }
  },
})

const useCommand = defineSinkCommand({
  meta: { name: 'use', description: 'Set the default profile' },
  args: {
    ...GLOBAL_ARGS,
    name: { type: 'positional', description: 'Profile name', required: true },
  } satisfies ArgsDef,
  async run({ args }) {
    const name = args.name !== '' ? args.name : args._[0]
    const config = readConfig()
    if (typeof name !== 'string' || name === '' || config.profiles[name] === undefined) {
      const known = Object.keys(config.profiles).sort()
      throw new ConfigError(known.length === 0
        ? `No profiles are configured. Run "sink profiles add <name> --url <url> --token <token>" first.`
        : `Unknown profile "${String(name)}". Known profiles: ${known.join(', ')}.`)
    }
    config.defaultProfile = name
    writeConfig(config)

    if (args.json === true) {
      printJson({ defaultProfile: name })
      return
    }
    printLine(name)
  },
})

const listCommand = defineSinkCommand({
  meta: { name: 'list', description: 'List configured profiles and show the effective one' },
  args: {
    ...GLOBAL_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const config = readConfig()
    const names = Object.keys(config.profiles).sort()
    const overrides: string[] = []
    if (process.env.SINK_URL !== undefined && process.env.SINK_URL !== '') {
      overrides.push('SINK_URL')
    }
    if (process.env.SINK_TOKEN !== undefined && process.env.SINK_TOKEN !== '') {
      overrides.push('SINK_TOKEN')
    }

    if (args.json === true) {
      printJson({
        path: configPath(),
        defaultProfile: config.defaultProfile,
        profiles: Object.fromEntries(names.map(name => [name, { url: config.profiles[name]?.url, token: maskToken(config.profiles[name]?.token ?? '') }])),
        environmentOverrides: overrides,
        environmentProfile: process.env.SINK_PROFILE ?? null,
      })
      return
    }

    printRecord([
      { key: 'config', value: configPath() },
      { key: 'defaultProfile', value: config.defaultProfile === '' ? '(none)' : config.defaultProfile, color: 'cyan' },
      { key: 'environment', value: overrides.length === 0 ? '(no overrides)' : overrides.join(', ') },
    ])

    if (names.length === 0) {
      notice('no profiles configured yet; run "sink profiles add <name> --url <url> --token <token>"')
      return
    }

    printLine()
    printTable(names, [
      { header: 'name', value: name => name, color: 'cyan' },
      { header: 'url', value: name => config.profiles[name]?.url ?? '' },
      { header: 'token', value: name => maskToken(config.profiles[name]?.token ?? '') },
      { header: 'default', value: name => (name === config.defaultProfile ? 'yes' : '') },
    ])
  },
})

const removeCommand = defineSinkCommand({
  meta: { name: 'remove', description: 'Delete a profile from the config file' },
  args: {
    ...GLOBAL_ARGS,
    name: { type: 'positional', description: 'Profile name', required: true },
  } satisfies ArgsDef,
  async run({ args }) {
    const name = args.name !== '' ? args.name : args._[0]
    const config = readConfig()
    if (typeof name !== 'string' || name === '' || config.profiles[name] === undefined) {
      const known = Object.keys(config.profiles).sort()
      throw new ConfigError(`Unknown profile "${String(name)}".${known.length > 0 ? ` Known profiles: ${known.join(', ')}.` : ''}`)
    }

    delete config.profiles[name]
    if (config.defaultProfile === name) {
      config.defaultProfile = Object.keys(config.profiles).sort()[0] ?? ''
    }
    writeConfig(config)

    if (args.json === true) {
      printJson({ removed: name, defaultProfile: config.defaultProfile })
      return
    }
    printLine(name)
  },
})

export const profilesCommand: CommandDef = {
  meta: { name: 'profiles', description: 'Manage stored connection profiles' },
  args: GLOBAL_ARGS,
  subCommands: {
    add: addCommand,
    use: useCommand,
    list: listCommand,
    remove: removeCommand,
  },
}
