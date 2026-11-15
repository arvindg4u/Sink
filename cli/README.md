# @sink/cli

A command-line client for the [Sink](https://sink.cool) link-shortener REST API.

It wraps every `/api/**` endpoint the instance exposes — links, analytics, tags,
backup and verification — behind a single `sink` binary, adds stored connection
profiles, and can expose the instance to an MCP host over stdio.

## What it solves

- **One place for connection details.** The base URL and bearer token live in a
  profile file (`~/.config/sink/config.json`, mode `600`) instead of being
  pasted into every `curl` invocation. Environment variables override the file
  when you need a one-off instance.
- **Readable output.** Lists are printed as column-aligned tables sized to their
  content, with colour that follows the usual `NO_COLOR`/TTY rules and a
  `--json` switch on every command for piping into `jq`.
- **Scriptable.** Data goes to stdout, notices go to stderr, `--quiet` emits
  tab-separated rows, and failures carry distinct exit codes.
- **MCP without configuration drift.** `sink mcp serve` bridges an MCP host to
  the instance's own MCP endpoint, so tool names, descriptions and schemas are
  always the ones the server actually publishes.

## Requirements

- Node.js 24 or newer.

## Install

```bash
# from the monorepo
pnpm --filter @sink/cli build

# from a packed tarball
npm install -g ./sink-cli-0.3.1.tgz

# or run without installing
npx @sink/cli --help
```

The published package ships only `dist`, `README.md` and `LICENSE`, and
`prepack` rebuilds `dist` so a tarball can never contain stale output.

## Authenticate

Create a profile once, then every command uses it:

```bash
sink profiles add prod --url https://sink.example.com --token <token> --use
sink verify
```

```
profile        prod
source         profile
url            https://sink.example.com
name           Sink
authMethod     site-token
userID         root
credentials are valid
```

### Configuration file

`~/.config/sink/config.json`, or `$XDG_CONFIG_HOME/sink/config.json` when
`XDG_CONFIG_HOME` is set:

```json
{
  "defaultProfile": "prod",
  "profiles": {
    "prod": { "url": "https://sink.example.com", "token": "…" }
  }
}
```

The file is written with mode `600` and its directory with `700`, because it
holds bearer tokens.

### Precedence

1. `--profile <name>`
2. `SINK_PROFILE`
3. `config.defaultProfile`

The selected profile supplies `url` and `token`; `SINK_URL` and `SINK_TOKEN`
then override them field by field. `SINK_URL` plus `SINK_TOKEN` alone is enough
to run without any config file.

## Global flags

Available on every command:

| Flag                     | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `--profile <name>`       | Profile to use, overriding `SINK_PROFILE` and the config default |
| `--json`                 | Print the raw API response as pretty JSON on stdout              |
| `--quiet`                | Tab-separated values, no headers, no notices                     |
| `--color` / `--no-color` | Force or suppress ANSI colour                                    |
| `--timeout <seconds>`    | Request timeout (default `30`, max `600`)                        |

Colour policy: explicit flag > `FORCE_COLOR` > `NO_COLOR` > TTY detection.
`--json` never emits colour.

### Exit codes

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| `0`  | Success                                                             |
| `1`  | The API refused the request, or the command failed                  |
| `2`  | The command line was wrong (unknown flag/command, missing argument) |
| `3`  | No usable profile or configuration                                  |
| `4`  | The instance could not be reached                                   |

### Output contract

| Stream | Carries                                                  |
| ------ | -------------------------------------------------------- |
| stdout | The command result: a table, a record, a scalar, or JSON |
| stderr | Notices, warnings and errors                             |

Notices are suppressed by `--quiet`; errors never are. Scripts can therefore
capture stdout safely:

```bash
slug=$(sink links create --url https://example.com --quiet)
```

## Commands

### `sink links`

| Command            | Endpoint                         | Notes                                                    |
| ------------------ | -------------------------------- | -------------------------------------------------------- |
| `list`             | `GET /api/link/list`             | `--limit --cursor --sort --tag --status --all`           |
| `get <slug>`       | `GET /api/link/query`            | Full record, including flags and geo rules               |
| `create`           | `POST /api/link/create`          | Requires `--url`; fails when the slug is taken           |
| `update <slug>`    | `PUT /api/link/edit`             | Replaces the link; omitted optional fields are cleared   |
| `delete <slug>`    | `POST /api/link/delete`          | Prints the deleted slug                                  |
| `upsert`           | `POST /api/link/upsert`          | Creates when absent, returns the existing link otherwise |
| `search`           | `GET /api/link/search`           | One of `--q` or `--url` is required                      |
| `count`            | `GET /api/link/count`            | Prints the bare number                                   |
| `export`           | `GET /api/link/export`           | Sink import document; `--output <file>` writes to disk   |
| `import <file>`    | `POST /api/link/import`          | `-` reads the document from stdin                        |
| `check`            | `POST /api/link/check`           | `--limit` (1-10), `--timeout` (1-30), `--all`            |
| `tags`             | `GET /api/link/tags`             | Also available as top-level `sink tags`                  |
| `ai <url>`         | `GET /api/link/ai`               | Generates a slug                                         |
| `og-ai <url>`      | `GET /api/link/og-ai`            | Generates OpenGraph metadata                             |
| `upload <file>`    | `POST /api/upload/image`         | Preview image for `--slug`                               |
| `migration status` | `GET /api/link/migration/status` | KV to D1 migration state                                 |
| `migration run`    | `POST /api/link/migration/run`   | `--cursor`, `--force`                                    |

Link fields accepted by `create`, `update` and `upsert`:

`--url --slug --comment --expiration --title --description --image --apple
--google --cloaking --redirect-with-query --proxy --password --unsafe --geo
--tags`

- `--expiration` accepts unix seconds or an ISO-8601 date.
- `--geo` takes `CODE=url` pairs: `--geo US=https://a.com,DE=https://b.de`.
- `--tags` takes a comma-separated list (at most 10, each 1-32 characters).
- Boolean flags are always sent explicitly. The API treats an omitted boolean
  and `false` identically for both create and edit, so `update --url … <slug>`
  resets unspecified booleans to `false`.

Examples:

```bash
sink links list --limit 50 --sort az
sink links list --tag launch --status all
sink links create --url https://example.com/launch --slug launch \
  --comment "spring campaign" --tags campaign,spring \
  --expiration 2026-12-31T00:00:00Z --cloaking
sink links get launch --json | jq '.tags'
sink links update launch --url https://example.com/launch-v2 --tags campaign
sink links search --q campaign --limit 5
sink links count --tag campaign --status all
sink links export --output links.json
sink links import links.json
sink links check --limit 10 --all
sink links delete launch
```

### `sink stats`

Every analytics command accepts the same access-log filters, each of which takes
a comma-separated list: `--slug --url --referer --country --region --city
--timezone --language --os --browser --browser-type --device --device-type`,
plus `--id --start-at --end-at` (unix seconds or ISO-8601).

| Command    | Endpoint                  | Extra flags                                                     |
| ---------- | ------------------------- | --------------------------------------------------------------- |
| `counters` | `GET /api/stats/counters` | —                                                               |
| `views`    | `GET /api/stats/views`    | `--unit minute\|hour\|day` (required), `--client-timezone`      |
| `metrics`  | `GET /api/stats/metrics`  | `--type <dimension>` (required), `--limit`, `--client-timezone` |
| `heatmap`  | `GET /api/stats/heatmap`  | `--client-timezone`                                             |
| `export`   | `GET /api/stats/export`   | Raw access-log CSV                                              |

`--type` accepts `slug url ua ip referer country region city timezone language os
browser browserType device deviceType COLO latitude longitude`.

```bash
sink stats counters --start-at 2026-01-01 --end-at 2026-02-01
sink stats views --unit day --slug launch
sink stats metrics --type country --limit 20
sink stats heatmap --client-timezone Europe/Warsaw
sink stats export --slug launch > access.csv
```

### `sink tags`

`GET /api/link/tags` — tag names with their link counts.

```bash
sink tags
sink tags --json | jq -r '.[].name'
```

### `sink backup`

`POST /api/backup` — asks the instance to snapshot its stored links.

```bash
sink backup
```

### `sink verify`

`GET /api/verify` — checks that the resolved profile can authenticate and
prints the effective profile, URL and identity.

```bash
sink verify --json
```

### `sink profiles`

| Command                                          | Purpose                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `add <name> --url <url> --token <token> [--use]` | Create or replace a profile                                            |
| `use <name>`                                     | Set the default profile                                                |
| `list`                                           | Show the config path, default, environment overrides and masked tokens |
| `remove <name>`                                  | Delete a profile, reassigning the default when needed                  |

```bash
sink profiles add staging --url https://staging.example.com --token <token>
sink profiles use staging
sink profiles list --json
sink profiles remove staging
```

### `sink mcp`

```bash
sink mcp serve   # MCP server over stdio, proxying to the resolved profile
sink mcp tools   # list the tools the instance exposes
```

`sink mcp serve` speaks MCP over stdio and forwards `tools/list` and
`tools/call` to `POST {url}/api/mcp` (JSON-RPC over Streamable HTTP with a
bearer token). Because the local server proxies the remote endpoint rather than
re-declaring tools, it always exposes exactly what the instance publishes:

`list_links`, `search_links`, `get_link`, `count_links`, `list_tags`,
`create_link`, `update_link`, `upsert_link`, `delete_link`, `check_links`,
`get_analytics_counters`, `get_analytics_views`, `get_analytics_metrics`,
`get_analytics_heatmap` (plus anything a future instance adds).

stdout is reserved for the JSON-RPC channel; diagnostics go to stderr.

Claude Desktop / Cursor configuration:

```json
{
  "mcpServers": {
    "sink": {
      "command": "sink",
      "args": ["mcp", "serve", "--profile", "prod"]
    }
  }
}
```

Servers that cannot inherit a shell environment can pass credentials directly:

```json
{
  "mcpServers": {
    "sink": {
      "command": "sink",
      "args": ["mcp", "serve"],
      "env": {
        "SINK_URL": "https://sink.example.com",
        "SINK_TOKEN": "<token>"
      }
    }
  }
}
```

Verify the bridge without a host:

```bash
npx @modelcontextprotocol/inspector sink mcp serve
```

## Development

```bash
pnpm build               # tsc -> dist, then assert the shebang and mode 755
pnpm selfcheck           # 35 end-to-end checks against a local stub instance
pnpm pack                # builds via prepack, then packs
```

`scripts/selfcheck.mjs` starts a stub HTTP server that replays the recorded
response shapes (including the MCP SSE endpoint), runs the built binary against
it, and asserts tables, JSON/quiet modes, exit codes, profile handling, file
permissions and a full MCP stdio handshake. It needs no network access.

## Dependencies

Kept deliberately small:

| Package                        | Why                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `citty`                        | Command/flag parsing and usage rendering. Zero dependencies, ESM, already part of the unjs ecosystem this repo builds on. |
| `@modelcontextprotocol/server` | The official MCP TypeScript SDK v2, used for the stdio transport and JSON-RPC framing in `sink mcp serve`.                |

Everything else — argument validation, table rendering, colour handling, the
HTTP client and MCP proxying — is implemented here on Node's built-in `fetch`,
`node:util` and `node:fs`.

## License

AGPL-3.0-only, matching the Sink project.
