import { describe, expect, test } from 'bun:test'
import type { OAuthTokens } from 'src/services/oauth/types.js'
import {
  getClaudeAIOAuthTokensForScopes,
  getClaudeAIOAuthTokensForScopesSync,
} from 'src/utils/auth.js'

const REMOTE_SCOPES = ['user:profile', 'user:sessions:claude_code'] as const

function createTokens(
  accessToken: string,
  scopes: string[],
  overrides: Partial<OAuthTokens> = {},
): OAuthTokens {
  return {
    accessToken,
    refreshToken: null,
    expiresAt: null,
    scopes,
    subscriptionType: null,
    rateLimitTier: null,
    ...overrides,
  }
}

describe('scoped OAuth token resolution', () => {
  test('prefers the stored Claude token when the active env token lacks remote scopes', async () => {
    const resolved = await getClaudeAIOAuthTokensForScopes(REMOTE_SCOPES, {
      getActiveTokens: () => createTokens('env-token', ['user:inference']),
      getStoredTokens: async () =>
        createTokens('stored-token', [
          'user:inference',
          'user:profile',
          'user:sessions:claude_code',
        ]),
    })

    expect(resolved?.accessToken).toBe('stored-token')
  })

  test('keeps the active token when it already satisfies the required scopes', async () => {
    const resolved = await getClaudeAIOAuthTokensForScopes(REMOTE_SCOPES, {
      getActiveTokens: () =>
        createTokens('active-token', [
          'user:inference',
          'user:profile',
          'user:sessions:claude_code',
        ]),
      getStoredTokens: async () =>
        createTokens('stored-token', [
          'user:inference',
          'user:profile',
          'user:sessions:claude_code',
        ]),
    })

    expect(resolved?.accessToken).toBe('active-token')
  })

  test('refreshes an expired stored token before returning it for remote scopes', async () => {
    const savedTokens: OAuthTokens[] = []
    const refreshed = createTokens(
      'refreshed-token',
      ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      {
        refreshToken: 'refresh-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    )

    const resolved = await getClaudeAIOAuthTokensForScopes(REMOTE_SCOPES, {
      getActiveTokens: () => createTokens('env-token', ['user:inference']),
      getStoredTokens: async () =>
        createTokens('stored-token', ['user:inference', 'user:profile'], {
          refreshToken: 'refresh-token',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      isTokenExpired: () => true,
      refreshToken: async refreshToken => {
        expect(refreshToken).toBe('refresh-token')
        return refreshed
      },
      saveTokens: tokens => {
        savedTokens.push(tokens)
        return { success: true }
      },
    })

    expect(resolved?.accessToken).toBe('refreshed-token')
    expect(savedTokens).toEqual([refreshed])
  })

  test('sync resolver also falls back to stored full-scope tokens for reconnects', () => {
    const resolved = getClaudeAIOAuthTokensForScopesSync(REMOTE_SCOPES, {
      getActiveTokens: () => createTokens('env-token', ['user:inference']),
      getStoredTokens: () =>
        createTokens('stored-token', [
          'user:inference',
          'user:profile',
          'user:sessions:claude_code',
        ]),
    })

    expect(resolved?.accessToken).toBe('stored-token')
  })
})
