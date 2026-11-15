import type { H3Event } from 'h3'
import { createError } from 'h3'
import { isCloudflareAccessConfigured } from './cloudflare-access'

export interface VerificationResponse {
  name: string
  url: string
  authMethod: 'site-token' | 'access-user' | 'access-service'
  userID: string
  userEmail: string
  accessEnabled: boolean
}

/**
 * Describes the verified caller. Shared by `GET /api/verify` and the MCP
 * `verify` tool so both report the same identity for the same credential.
 */
export function buildVerificationResponse(event: H3Event): VerificationResponse {
  const authMethod: unknown = event.context.authMethod
  const userID: unknown = event.context.userID
  const userEmail: unknown = event.context.userEmail
  if (
    (
      authMethod !== 'site-token'
      && authMethod !== 'access-user'
      && authMethod !== 'access-service'
    )
    || typeof userID !== 'string'
    || !userID
    || typeof userEmail !== 'string'
    || !userEmail
  ) {
    throw createError({
      status: 401,
      statusText: 'Unauthorized',
    })
  }

  const { cfAccessTeamDomain, cfAccessAud } = useRuntimeConfig(event)

  return {
    name: 'Sink',
    url: 'https://sink.cool',
    authMethod,
    userID,
    userEmail,
    accessEnabled: isCloudflareAccessConfigured(cfAccessTeamDomain, cfAccessAud),
  }
}
