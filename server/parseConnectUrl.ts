/**
 * Phantom stub — parses cc:// and cc+unix:// direct-connect URLs.
 *
 * Call shape derived from main.tsx callsites (lines 619–621, 4079–4085):
 *   const { parseConnectUrl } = await import('./server/parseConnectUrl.js')
 *   const { serverUrl, authToken } = parseConnectUrl(ccUrl)
 */

export type ParsedConnectUrl = {
  serverUrl: string
  authToken: string
}

// FIXME: ambiguous shape — real implementation likely also parses
// cc+unix:// socket paths and may carry workDir/session hints. Callsites
// only destructure serverUrl + authToken, so those are the guaranteed
// fields; extend as needed when the real source is restored.
export function parseConnectUrl(_url: string): ParsedConnectUrl {
  throw new Error('not implemented')
}
