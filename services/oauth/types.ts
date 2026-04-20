export type SubscriptionType = 'max' | 'pro' | 'enterprise' | 'team'

export type RateLimitTier = string

export type BillingType = string

export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  account?: { uuid: string; email_address: string }
  organization?: { uuid: string }
}

export type OAuthProfileResponse = {
  organization?: {
    organization_type?:
      | 'claude_max'
      | 'claude_pro'
      | 'claude_enterprise'
      | 'claude_team'
      | string
    uuid?: string
    name?: string
    has_extra_usage_enabled?: boolean
    billing_type?: BillingType
    subscription_created_at?: string
  }
  account?: {
    uuid?: string
    email_address?: string
    email?: string
    display_name?: string
    created_at?: string
  }
  [key: string]: unknown
}

export type UserRolesResponse = {
  organization_role?: string
  workspace_role?: string
  organization_name?: string
}

export type OAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}
