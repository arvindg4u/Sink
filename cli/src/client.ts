import { ApiError, NetworkError, toError } from './errors.js'

export type QueryValue = string | number | boolean | Array<string | number> | undefined | null
export type QueryInput = Record<string, QueryValue>

export interface SinkClientOptions {
  url: string
  token: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Sent as `X-Sink-Client` so the instance can tell CLI traffic apart. */
  clientTag?: string
}

interface RequestOptions {
  query?: QueryInput
  body?: unknown
  formData?: FormData
  accept?: string
  /** Return the response body as text instead of parsing JSON. */
  text?: boolean
}

interface JsonRpcErrorPayload {
  code: number
  message: string
  data?: unknown
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: JsonRpcErrorPayload
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_ERROR_BODY = 500

function describeIssues(raw: string): string[] {
  const issues: unknown = tryParseJson(raw)
  if (!Array.isArray(issues)) {
    return []
  }
  return issues.map((issue) => {
    if (typeof issue !== 'object' || issue === null) {
      return String(issue)
    }
    const record = issue as { path?: unknown, message?: unknown }
    const path = Array.isArray(record.path) && record.path.length > 0 ? record.path.join('.') : '(root)'
    return `${path}: ${String(record.message ?? 'invalid')}`
  })
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch {
    return undefined
  }
}

function truncateBody(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_ERROR_BODY ? `${collapsed.slice(0, MAX_ERROR_BODY)}…` : collapsed
}

/** Turn a non-2xx response into an {@link ApiError} with useful detail lines. */
function toApiError(response: Response, body: string): ApiError {
  const payload = tryParseJson(body)
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const statusMessage = typeof record.statusMessage === 'string' ? record.statusMessage : response.statusText
  const rawMessage = typeof record.message === 'string' ? record.message : ''
  const details = rawMessage === '' ? [] : describeIssues(rawMessage)
  const summary = `${response.status} ${statusMessage || 'Request failed'}`
  const message = rawMessage === '' || details.length > 0 ? summary : `${summary}: ${rawMessage}`
  // The standard Sink error envelope is fully described by its status line, so
  // the raw body is only echoed when the payload is something else entirely.
  const isEnvelope = record.error === true && typeof record.statusCode === 'number'
  const fallback = details.length === 0 && rawMessage === '' && !isEnvelope && body.trim() !== '' ? [truncateBody(body)] : []
  return new ApiError(message, response.status, response.url, [...details, ...fallback])
}

function toNetworkError(error: unknown, url: string): NetworkError {
  const cause = toError(error)
  const reason = cause.name === 'TimeoutError' ? 'the request timed out' : cause.message
  return new NetworkError(`Could not reach ${url}: ${reason}`, url, { cause })
}

interface RpcParseContext {
  contentType: string
  id: number
}

/** Extract the JSON-RPC message from a plain JSON or Server-Sent-Events response. */
function parseRpcMessage(body: string, context: RpcParseContext): JsonRpcMessage | undefined {
  if (context.contentType.includes('text/event-stream')) {
    const messages: JsonRpcMessage[] = []
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) {
        continue
      }
      const parsed = tryParseJson(line.slice(5).trim())
      if (typeof parsed === 'object' && parsed !== null) {
        messages.push(parsed as JsonRpcMessage)
      }
    }
    return messages.find(message => message.id === context.id) ?? messages.find(message => message.result !== undefined || message.error !== undefined)
  }
  const parsed = tryParseJson(body)
  return typeof parsed === 'object' && parsed !== null ? (parsed as JsonRpcMessage) : undefined
}

export class SinkClient {
  readonly url: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly clientTag: string
  private rpcId = 1

  constructor(options: SinkClientOptions) {
    this.url = options.url
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.clientTag = options.clientTag ?? '@sink/cli'
  }

  buildUrl(path: string, query: QueryInput = {}): string {
    const url = new URL(path.startsWith('http') ? path : `${this.url}${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        continue
      }
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    return url.toString()
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query)
    const headers: Record<string, string> = {
      'authorization': `Bearer ${this.token}`,
      'accept': options.accept ?? 'application/json',
      'user-agent': this.clientTag,
    }

    let body: string | FormData | undefined
    if (options.formData !== undefined) {
      body = options.formData
    }
    else if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }

    let response: Response
    try {
      response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) })
    }
    catch (error) {
      throw toNetworkError(error, url)
    }

    let raw: string
    try {
      raw = await response.text()
    }
    catch (error) {
      throw toNetworkError(error, url)
    }

    if (!response.ok) {
      throw toApiError(response, raw)
    }
    if (options.text === true) {
      return raw as T
    }
    if (raw.trim() === '') {
      return undefined as T
    }
    const parsed = tryParseJson(raw)
    if (parsed === undefined) {
      throw new ApiError(`Expected JSON from ${url} but the response was not JSON.`, response.status, url, [truncateBody(raw)])
    }
    return parsed as T
  }

  get<T>(path: string, query?: QueryInput): Promise<T> {
    return this.request<T>('GET', path, { query })
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body === undefined ? {} : { body })
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body === undefined ? {} : { body })
  }

  /**
   * Call a JSON-RPC method on the instance's MCP endpoint.
   *
   * Sink serves MCP over Streamable HTTP with an SSE body, so the response is
   * either `application/json` or a `text/event-stream` frame stream.
   */
  async jsonRpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.rpcId
    this.rpcId += 1
    const url = `${this.url}/api/mcp`
    const payload = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.token}`,
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'user-agent': this.clientTag,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    }
    catch (error) {
      throw toNetworkError(error, url)
    }

    const raw = await response.text()
    if (!response.ok) {
      throw toApiError(response, raw)
    }

    const message = parseRpcMessage(raw, { contentType: response.headers.get('content-type') ?? '', id })
    if (message === undefined) {
      throw new ApiError('The MCP endpoint returned no JSON-RPC message.', response.status, url, [truncateBody(raw)])
    }
    if (message.error !== undefined) {
      throw new ApiError(`MCP error ${message.error.code}: ${message.error.message}`, response.status, url)
    }
    return message.result as T
  }
}
