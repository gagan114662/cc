// Phantom stub — inbound webhook content sanitizer. Not reconstructed in
// this external build. Gated at the call site via
// feature('KAIROS_GITHUB_WEBHOOKS').

export function sanitizeInboundWebhookContent(content: string): string {
  // Identity pass-through; the real sanitizer is ant-only.
  return content
}
