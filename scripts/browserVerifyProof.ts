#!/usr/bin/env bun

import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { chromium, type Page } from 'playwright'

export type BrowserVerifyOptions = {
  targetPath: string
  htmlPath: string
  artifactDir: string
  featureName: string
}

type BrowserVerificationArtifact = {
  featureName: string
  targetPath: string
  videoWebmPath: string
  videoMp4Path: string | null
  posterPath: string
}

export function parseArgs(argv: string[]): BrowserVerifyOptions {
  let targetPath = './build-trust-proof.html'
  let htmlPath = './build-trust-browser-verification.html'
  let artifactDir = './build-trust-artifacts'
  let featureName = 'Build trust review console'

  const iterator = argv[Symbol.iterator]()
  for (let current = iterator.next(); !current.done; current = iterator.next()) {
    const arg = current.value
    if (arg === '--target') {
      const next = iterator.next()
      targetPath = next.done ? targetPath : next.value
      continue
    }
    if (arg === '--html') {
      const next = iterator.next()
      htmlPath = next.done ? htmlPath : next.value
      continue
    }
    if (arg === '--artifacts') {
      const next = iterator.next()
      artifactDir = next.done ? artifactDir : next.value
      continue
    }
    if (arg === '--feature-name') {
      const next = iterator.next()
      featureName = next.done ? featureName : next.value
    }
  }

  return {
    targetPath: path.resolve(targetPath),
    htmlPath: path.resolve(htmlPath),
    artifactDir: path.resolve(artifactDir),
    featureName,
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function clickNav(page: Page, id: string): Promise<void> {
  await page.locator(`[data-proof-nav="${id}"]`).click()
  await wait(900)
}

async function recordProofTour(page: Page): Promise<void> {
  await page.waitForSelector('#review-console')
  await wait(700)
  const search = page.locator('#review-search')
  const category = page.locator('#review-category')
  const severity = page.locator('#review-severity')
  const blockers = page.locator('#review-blockers-only')
  await clickNav(page, 'review-console')
  await search.click()
  await search.fill('runner')
  await wait(700)
  await category.selectOption('coverage')
  await wait(700)
  await severity.selectOption('critical')
  await wait(700)
  await blockers.click()
  await wait(700)
  const firstVisibleLink = page
    .locator('[data-review-item]:not([hidden]) a')
    .first()
  if (await firstVisibleLink.count()) {
    await firstVisibleLink.click()
    await wait(900)
  }
  await clickNav(page, 'review-console')
  await search.fill('')
  await category.selectOption('all')
  await severity.selectOption('all')
  if ((await blockers.getAttribute('aria-pressed')) === 'true') {
    await blockers.click()
    await wait(700)
  }
  await wait(900)
}

function runFfmpeg(inputPath: string, outputPath: string): boolean {
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-movflags',
      'faststart',
      '-pix_fmt',
      'yuv420p',
      outputPath,
    ],
    { stdio: 'pipe' },
  )
  return result.status === 0
}

export function renderBrowserVerificationHtml(
  artifact: BrowserVerificationArtifact,
  repoRoot: string,
): string {
  const relativeTarget = path.relative(repoRoot, artifact.targetPath) || path.basename(artifact.targetPath)
  const relativePoster = path.relative(repoRoot, artifact.posterPath)
  const relativeWebm = path.relative(repoRoot, artifact.videoWebmPath)
  const relativeMp4 = artifact.videoMp4Path
    ? path.relative(repoRoot, artifact.videoMp4Path)
    : null

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser verification</title>
    <style>
      :root {
        --bg: #f4efe6;
        --panel: #fffaf2;
        --ink: #171717;
        --muted: #5f5a52;
        --accent: #92400e;
        --border: #dccdb3;
      }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, #fff4d8, transparent 28%),
          linear-gradient(180deg, #f8f4ec, var(--bg));
        color: var(--ink);
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 44px 20px 80px;
      }
      section {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 22px 24px;
        box-shadow: 0 20px 40px rgba(23, 23, 23, 0.06);
      }
      section + section {
        margin-top: 18px;
      }
      .meta {
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: 1.25fr 0.75fr;
        gap: 18px;
      }
      video, img {
        width: 100%;
        display: block;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: #000;
      }
      a {
        color: var(--accent);
      }
      code {
        font-family: "IBM Plex Mono", monospace;
      }
      @media (max-width: 900px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section id="overview">
        <p class="meta">Browser verification artifact</p>
        <h1>${escapeHtml(artifact.featureName)}</h1>
        <p>This artifact records a real Chromium walkthrough of <code>${escapeHtml(relativeTarget)}</code> and embeds the captured browser video directly for review.</p>
      </section>
      <section>
        <div class="grid">
          <div>
            <h2>Embedded video</h2>
            <video controls preload="metadata" poster="${escapeHtml(relativePoster)}">
              ${relativeMp4 ? `<source src="${escapeHtml(relativeMp4)}" type="video/mp4" />` : ''}
              <source src="${escapeHtml(relativeWebm)}" type="video/webm" />
            </video>
          </div>
          <div>
            <h2>What this proves</h2>
            <p>The browser feature under test is the review console inside the build-trust proof page. The recording shows real search input, category and severity filters, blocker-only mode, and a jump from a filtered card into the matching proof section.</p>
            <p><a href="${escapeHtml(relativeTarget)}">Open target proof</a></p>
            <p><a href="${escapeHtml(relativePoster)}">Open poster screenshot</a></p>
            ${relativeMp4 ? `<p><a href="${escapeHtml(relativeMp4)}">Open MP4 video</a></p>` : ''}
            <p><a href="${escapeHtml(relativeWebm)}">Open WebM video</a></p>
          </div>
        </div>
      </section>
      <section>
        <h2>Verification script</h2>
        <p>The recorder opens the proof in Chromium, focuses <code>review-console</code>, searches for <code>runner</code>, filters to <code>coverage</code> and <code>critical</code>, enables blocker-only mode, opens the first visible inspection link, then resets the filters.</p>
      </section>
    </main>
  </body>
</html>`
}

export async function createBrowserVerification(
  options: BrowserVerifyOptions,
): Promise<BrowserVerificationArtifact> {
  await mkdir(options.artifactDir, { recursive: true })
  const targetFileUrl = new URL(`file://${options.targetPath}`)
  const baseName = path.basename(options.targetPath, path.extname(options.targetPath))
  const videoDir = path.join(options.artifactDir, 'browser-video-temp')
  const posterPath = path.join(options.artifactDir, `${baseName}-browser-verification-poster.png`)
  const finalWebmPath = path.join(options.artifactDir, `${baseName}-browser-verification.webm`)
  const finalMp4Path = path.join(options.artifactDir, `${baseName}-browser-verification.mp4`)

  await mkdir(videoDir, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    recordVideo: {
      dir: videoDir,
      size: { width: 1440, height: 960 },
    },
    colorScheme: 'light',
  })
  const page = await context.newPage()
  const video = page.video()

  try {
    await page.goto(targetFileUrl.toString(), {
      waitUntil: 'load',
    })
    await recordProofTour(page)
    await page.screenshot({
      path: posterPath,
      fullPage: false,
    })
  } finally {
    await page.close()
    await context.close()
    await browser.close()
  }

  const recordedVideoPath = await video?.path()
  if (!recordedVideoPath) {
    throw new Error('Playwright did not produce a browser video recording.')
  }
  await rename(recordedVideoPath, finalWebmPath)
  const mp4Created = runFfmpeg(finalWebmPath, finalMp4Path)

  return {
    featureName: options.featureName,
    targetPath: options.targetPath,
    videoWebmPath: finalWebmPath,
    videoMp4Path: mp4Created ? finalMp4Path : null,
    posterPath,
  }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  const artifact = await createBrowserVerification(options)
  const html = renderBrowserVerificationHtml(artifact, process.cwd())
  await writeFile(options.htmlPath, html, 'utf8')
  process.stdout.write(`Browser verification written to ${options.htmlPath}\n`)
}
