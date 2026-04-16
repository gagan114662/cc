// test-intent: proves browser verification artifacts embed real video sources and describe the interactive review-console feature.
// test-spec: specs/build-trust-harness.md#proof-report
import { describe, expect, test } from 'bun:test'
import {
  parseArgs,
  renderBrowserVerificationHtml,
} from '../scripts/browserVerifyProof.js'

describe('browserVerifyProof', () => {
  test('parses explicit cli options into absolute browser verification paths', () => {
    const parsed = parseArgs([
      '--target',
      './custom-proof.html',
      '--html',
      './custom-verification.html',
      '--artifacts',
      './custom-artifacts',
      '--feature-name',
      'Custom review feature',
    ])

    expect(parsed.targetPath.endsWith('/custom-proof.html')).toBe(true)
    expect(parsed.htmlPath.endsWith('/custom-verification.html')).toBe(true)
    expect(parsed.artifactDir.endsWith('/custom-artifacts')).toBe(true)
    expect(parsed.featureName).toBe('Custom review feature')
  })

  test('preserves defaults when a cli flag is missing its value', () => {
    const parsed = parseArgs([
      '--target',
      './custom-proof.html',
      '--feature-name',
    ])

    expect(parsed.targetPath.endsWith('/custom-proof.html')).toBe(true)
    expect(parsed.htmlPath.endsWith('/build-trust-browser-verification.html')).toBe(
      true,
    )
    expect(parsed.artifactDir.endsWith('/build-trust-artifacts')).toBe(true)
    expect(parsed.featureName).toBe('Build trust review console')
  })

  test('renders an embedded browser video artifact html page', () => {
    const html = renderBrowserVerificationHtml(
      {
        featureName: 'Build trust review console',
        targetPath: '/repo/build-trust-proof.html',
        videoWebmPath: '/repo/build-trust-artifacts/proof.webm',
        videoMp4Path: '/repo/build-trust-artifacts/proof.mp4',
        posterPath: '/repo/build-trust-artifacts/proof-poster.png',
      },
      '/repo',
    )

    expect(html.includes('id="overview"')).toBe(true)
    expect(html.includes('<video controls')).toBe(true)
    expect(html.includes('build-trust-artifacts/proof.mp4')).toBe(true)
    expect(html.includes('build-trust-artifacts/proof.webm')).toBe(true)
    expect(html.includes('Build trust review console')).toBe(true)
    expect(html.includes('review console inside the build-trust proof page')).toBe(
      true,
    )
    expect(html.includes('searches for <code>runner</code>')).toBe(true)
    expect(html.includes('build-trust-proof.html')).toBe(true)
  })

  test('falls back cleanly when mp4 conversion is unavailable', () => {
    const html = renderBrowserVerificationHtml(
      {
        featureName: 'Build trust review console',
        targetPath: '/repo/build-trust-proof.html',
        videoWebmPath: '/repo/build-trust-artifacts/proof.webm',
        videoMp4Path: null,
        posterPath: '/repo/build-trust-artifacts/proof-poster.png',
      },
      '/repo',
    )

    expect(html.includes('type="video/webm"')).toBe(true)
    expect(html.includes('type="video/mp4"')).toBe(false)
  })
})
