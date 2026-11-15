import type { ArgsDef, CommandDef } from 'citty'
import type { CounterData, HeatmapDataPoint, MetricItem, StatsEnvelope, ViewDataPoint } from '../api-types.js'
import { parseInteger } from '../format.js'
import { emptyNotice, printJson, printRecord, printTable } from '../output.js'
import { buildFilterQuery, clientFor, defineSinkCommand, FILTER_ARGS, GLOBAL_ARGS } from './args.js'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const METRIC_TYPES = [
  'slug',
  'url',
  'ua',
  'ip',
  'referer',
  'country',
  'region',
  'city',
  'timezone',
  'language',
  'os',
  'browser',
  'browserType',
  'device',
  'deviceType',
  'COLO',
  'latitude',
  'longitude',
] as const

const countersCommand = defineSinkCommand({
  meta: { name: 'counters', description: 'Total visits, unique visitors and referers' },
  args: {
    ...GLOBAL_ARGS,
    ...FILTER_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const response = await client.get<StatsEnvelope<CounterData>>('/api/stats/counters', buildFilterQuery(args))

    if (args.json === true) {
      printJson(response)
      return
    }
    const first = response.data[0]
    if (first === undefined) {
      emptyNotice('stats counters')
      return
    }
    printRecord([
      { key: 'visits', value: String(first.visits) },
      { key: 'visitors', value: String(first.visitors) },
      { key: 'referers', value: String(first.referers) },
    ])
  },
})

const viewsCommand = defineSinkCommand({
  meta: { name: 'views', description: 'Visits and visitors bucketed over time' },
  args: {
    ...GLOBAL_ARGS,
    ...FILTER_ARGS,
    'unit': {
      type: 'enum',
      description: 'Time bucket size',
      options: ['minute', 'hour', 'day'],
      required: true,
    },
    'client-timezone': {
      type: 'string',
      description: 'IANA timezone used to bucket timestamps',
      valueHint: 'timezone',
      default: 'Etc/UTC',
    },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const response = await client.get<StatsEnvelope<ViewDataPoint>>('/api/stats/views', {
      ...buildFilterQuery(args),
      unit: args.unit,
      clientTimezone: args.clientTimezone,
    })

    if (args.json === true) {
      printJson(response)
      return
    }
    if (response.data.length === 0) {
      emptyNotice('stats views')
      return
    }
    printTable(response.data, [
      { header: 'time', value: point => point.time, color: 'cyan' },
      { header: 'visits', value: point => String(point.visits), align: 'right' },
      { header: 'visitors', value: point => String(point.visitors), align: 'right' },
    ])
  },
})

const metricsCommand = defineSinkCommand({
  meta: { name: 'metrics', description: 'Top values for one access-log dimension' },
  args: {
    ...GLOBAL_ARGS,
    ...FILTER_ARGS,
    type: { type: 'enum', description: 'Access-log dimension to group by', options: [...METRIC_TYPES], required: true },
    limit: { type: 'string', description: 'Maximum rows (1-1000)', valueHint: 'count', default: '500' },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const limit = parseInteger(args.limit, 'limit', { min: 1, max: 1000 }) ?? 500
    const response = await client.get<StatsEnvelope<MetricItem>>('/api/stats/metrics', {
      ...buildFilterQuery(args),
      type: args.type,
      limit,
    })

    if (args.json === true) {
      printJson(response)
      return
    }
    if (response.data.length === 0) {
      emptyNotice('stats metrics')
      return
    }
    printTable(response.data, [
      { header: 'name', value: item => item.name, color: 'cyan' },
      { header: 'count', value: item => String(item.count), align: 'right' },
      { header: 'share', value: item => (item.percent === undefined ? '' : `${item.percent.toFixed(1)}%`), align: 'right' },
    ])
  },
})

const heatmapCommand = defineSinkCommand({
  meta: { name: 'heatmap', description: 'Visits bucketed by weekday and hour of day' },
  args: {
    ...GLOBAL_ARGS,
    ...FILTER_ARGS,
    'client-timezone': {
      type: 'string',
      description: 'IANA timezone used to bucket timestamps',
      valueHint: 'timezone',
      default: 'Etc/UTC',
    },
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const response = await client.get<StatsEnvelope<HeatmapDataPoint>>('/api/stats/heatmap', {
      ...buildFilterQuery(args),
      clientTimezone: args.clientTimezone,
    })

    if (args.json === true) {
      printJson(response)
      return
    }
    if (response.data.length === 0) {
      emptyNotice('stats heatmap')
      return
    }
    const sorted = [...response.data].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour)
    printTable(sorted, [
      { header: 'weekday', value: point => WEEKDAYS[point.weekday] ?? String(point.weekday) },
      { header: 'hour', value: point => `${String(point.hour).padStart(2, '0')}:00`, align: 'right' },
      { header: 'visits', value: point => String(point.visits), align: 'right' },
      { header: 'visitors', value: point => String(point.visitors), align: 'right' },
    ])
  },
})

const exportCommand = defineSinkCommand({
  meta: { name: 'export', description: 'Export raw access-log rows as CSV' },
  args: {
    ...GLOBAL_ARGS,
    ...FILTER_ARGS,
  } satisfies ArgsDef,
  async run({ args }) {
    const client = clientFor(args)
    const csv = await client.request<string>('GET', '/api/stats/export', {
      query: buildFilterQuery(args),
      text: true,
    })

    if (args.json === true) {
      printJson({ csv })
      return
    }
    process.stdout.write(csv.endsWith('\n') ? csv : `${csv}\n`)
  },
})

const statsCommand: CommandDef = {
  meta: { name: 'stats', description: 'Analytics counters, views, metrics and heatmap' },
  args: GLOBAL_ARGS,
  subCommands: {
    counters: countersCommand,
    views: viewsCommand,
    metrics: metricsCommand,
    heatmap: heatmapCommand,
    export: exportCommand,
  },
}

export { statsCommand }
