import type { CommandDef } from 'citty'
import { GLOBAL_ARGS } from './args.js'
import { linksCommand, tagsCommand } from './links.js'
import { mcpCommand } from './mcp.js'
import { profilesCommand } from './profiles.js'
import { statsCommand } from './stats.js'
import { backupCommand, verifyCommand } from './utility.js'

/**
 * Root command tree.
 *
 * Groups deliberately define no `run` handler: citty executes a parent's `run`
 * after its sub-command, so a handler here would fire on every nested call.
 */
export const mainCommand: CommandDef = {
  meta: {
    name: 'sink',
    description: 'Command-line interface for the Sink link shortener REST API',
  },
  args: GLOBAL_ARGS,
  subCommands: {
    links: linksCommand,
    stats: statsCommand,
    tags: tagsCommand,
    backup: backupCommand,
    verify: verifyCommand,
    profiles: profilesCommand,
    mcp: mcpCommand,
  },
}
