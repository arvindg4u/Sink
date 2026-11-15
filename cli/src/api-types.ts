/** Link record as returned by `/api/link/*`. */
export interface SinkLink {
  id?: string
  url: string
  slug: string
  comment?: string
  expiration?: number
  title?: string
  description?: string
  image?: string
  apple?: string
  google?: string
  cloaking?: boolean
  redirectWithQuery?: boolean
  proxy?: boolean
  unsafe?: boolean
  geo?: Record<string, string>
  tags?: string[]
  createdAt?: number
  updatedAt?: number
}

export interface LinkListResponse {
  links: SinkLink[]
  list_complete?: boolean
  cursor?: string
}

export interface LinkWriteResponse {
  link: SinkLink
  shortLink?: string
}

export interface TagCount {
  name: string
  count: number
}

export interface CountResponse {
  count: number
}

export interface CheckResult {
  slug: string
  url: string
  status?: number
  ok?: boolean
  duration?: number
  checkedAt?: string
  error?: string
}

export interface CheckResponse {
  results: CheckResult[]
  list_complete?: boolean
  cursor?: string
}

export interface ExportDocument {
  version: string
  exportedAt?: string
  count?: number
  links: SinkLink[]
  list_complete?: boolean
  cursor?: string
}

export interface ImportResult {
  success?: boolean
  imported?: number
  skipped?: number
  failed?: number
  message?: string
  [key: string]: unknown
}

export interface VerifyResponse {
  name?: string
  url?: string
  authMethod?: string
  userID?: string
  userEmail?: string
  accessEnabled?: boolean
}

export interface BackupResult {
  success?: boolean
  message?: string
  [key: string]: unknown
}

export interface MigrationStatus {
  completed: boolean
  marker?: Record<string, unknown>
}

export interface MigrationRunResult {
  completed: boolean
  list_complete?: boolean
  scanned: number
  inserted: number
  skipped: number
  expired: number
  failed: number
  failedItems?: unknown[]
}

export interface StatsEnvelope<T> {
  data: T[]
}

export interface CounterData {
  visits: number
  visitors: number
  referers: number
}

export interface ViewDataPoint {
  time: string
  visitors: number
  visits: number
}

export interface MetricItem {
  name: string
  count: number
  color?: string
  percent?: number
}

export interface HeatmapDataPoint {
  weekday: number
  hour: number
  visits: number
  visitors: number
}

/** Tool description as advertised by the instance's MCP endpoint. */
export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface McpListToolsResult {
  tools: McpTool[]
  nextCursor?: string
}

export interface McpTextContent {
  type: string
  text?: string
  [key: string]: unknown
}

export interface McpCallToolResult {
  content?: McpTextContent[]
  structuredContent?: unknown
  isError?: boolean
  [key: string]: unknown
}
