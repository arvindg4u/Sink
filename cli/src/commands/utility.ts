import type { ArgsDef } from 'citty'
import type { BackupResult, VerifyResponse } from '../api-types.js'
import { notice, printJson, printLine, printRecord } from '../output.js'
import { clientAndProfile, clientFor, defineSinkCommand, GLOBAL_ARGS } from './args.js'

const backupCommand = defineSinkCommand({
  meta: { name: 'backup', description: 'Ask the instance to snapshot its stored links' },
  args: {
    ...GLOBAL_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const result = await client.post<BackupResult>('/api/backup', {})

    if (args.json === true) {
      printJson(result)
      return
    }
    printLine(result.message ?? (result.success === false ? 'backup failed' : 'backup complete'))
  },
})

const verifyCommand = defineSinkCommand({
  meta: { name: 'verify', description: 'Check that the resolved profile can authenticate' },
  args: {
    ...GLOBAL_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const { client, profile } = clientAndProfile(args)
    const identity = await client.get<VerifyResponse>('/api/verify')

    if (args.json === true) {
      printJson({ profile: profile.name, source: profile.source, url: profile.url, identity })
      return
    }

    printRecord([
      { key: 'profile', value: profile.name ?? '(environment)', color: 'cyan' },
      { key: 'source', value: profile.source },
      { key: 'url', value: profile.url },
      { key: 'name', value: identity.name ?? '' },
      { key: 'authMethod', value: identity.authMethod ?? '' },
      { key: 'userID', value: identity.userID ?? '' },
      { key: 'userEmail', value: identity.userEmail ?? '' },
      { key: 'accessEnabled', value: String(identity.accessEnabled ?? false) },
    ])
    notice('credentials are valid')
  },
})

export { backupCommand, verifyCommand }
