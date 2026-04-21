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
    rate_limit_tier?: RateLimitTier
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
  // null when token comes from CLAUDE_CODE_OAUTH_TOKEN env or fd handoff
  // (inference-only flows have no refresh/expiry).
  refreshToken: string | null
  expiresAt: number | null
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

// Referral / guest-pass API types
export type ReferralCampaign =
  | 'claude_code_guest_pass'
  | 'claude_code_guest_pass_v1'
  | string

export type ReferrerRewardInfo = {
  currency: string
  amount_minor_units: number
}

export type ReferralRedemption = {
  id?: string
  redeemed_at?: string
  redeemer_email?: string
  status?: string
}

export type ReferralRedemptionsResponse = {
  redemptions?: ReferralRedemption[]
  limit?: number
}

export type ReferralEligibilityResponse = {
  eligible?: boolean
  referral_code_details?: {
    campaign?: string
    code?: string
  }
  referrer_reward?: ReferrerRewardInfo
  remaining_passes?: number
}
