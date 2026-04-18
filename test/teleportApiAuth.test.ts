import { describe, expect, test } from 'bun:test'
import type { OAuthTokens } from 'src/services/oauth/types.js'
import {
  prepareApiRequest,
  REMOTE_CLAUDE_CODE_REQUIRED_SCOPES,
} from 'src/utils/teleport/api.js'

function createTokens(
  accessToken: string,
  scopes: string[],
): OAuthTokens {
  return {
    accessToken,
    refreshToken: null,
    expiresAt: null,
    scopes,
    subscriptionType: null,
    rateLimitTier: null,
  }
}

describe('teleport API auth preparation', () => {
  test('falls back to profile lookup when the global org UUID cache is masked', async () => {
    const result = await prepareApiRequest({
      requiredScopes: REMOTE_CLAUDE_CODE_REQUIRED_SCOPES,
      getTokensForScopes: async () =>
        createTokens('stored-token', [
          'user:inference',
          'user:profile',
          'user:sessions:claude_code',
        ]),
      getOrganizationUUID: async () => null,
      getOauthProfileFromToken: async accessToken => {
        expect(accessToken).toBe('stored-token')
        return {
          account: {
            uuid: 'acct-123',
            email: 'dev@example.com',
          },
          organization: {
            uuid: 'org-123',
          },
        }
      },
    })

    expect(result).toEqual({
      accessToken: 'stored-token',
      orgUUID: 'org-123',
    })
  })

  test('throws a clear error when only an inference-only token is available', async () => {
    await expect(
      prepareApiRequest({
        requiredScopes: REMOTE_CLAUDE_CODE_REQUIRED_SCOPES,
        getTokensForScopes: async () =>
          createTokens('env-token', ['user:inference']),
        getOrganizationUUID: async () => null,
      }),
    ).rejects.toThrow(
      /Run `claude auth login --claudeai` or unset CLAUDE_CODE_OAUTH_TOKEN/,
    )
  })
})
