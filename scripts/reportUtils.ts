import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const preferredAnchor = "overview";
const referenceArtifacts = new Set([
  "session-transcript.html",
  "session-review.html",
  "session-retrospective.html",
]);

function hasHtmlShell(source: string): boolean {
  return /<!doctype html/i.test(source) || /<html[\s>]/i.test(source);
}

function hasOverviewAnchor(source: string): boolean {
  return /id=["']overview["']/i.test(source);
}

export function getRepoRoot(): string {
  return repoRoot;
}

export function getPreferredAnchor(): string {
  return preferredAnchor;
}

export function getArtifactKind(filePath: string): "reference" | "generated" {
  return referenceArtifacts.has(path.basename(filePath)) ? "reference" : "generated";
}

export async function resolveReportPath(inputPath: string): Promise<string> {
  const resolved = path.resolve(process.cwd(), inputPath);
  return realpath(resolved);
}

export function buildPreviewUrl(filePath: string): string {
  return `${pathToFileURL(filePath).href}#${preferredAnchor}`;
}

export async function validateReport(filePath: string): Promise<{
  filePath: string;
  previewUrl: string;
  artifactKind: "reference" | "generated";
}> {
  if (!filePath) {
    throw new Error("Pass an HTML file path, for example: bun run report:check ./analysis-deck.html");
  }

  const resolvedPath = await resolveReportPath(filePath);

  if (path.extname(resolvedPath).toLowerCase() !== ".html") {
    throw new Error(`Expected an .html file, received: ${resolvedPath}`);
  }

  await access(resolvedPath);

  if (path.dirname(resolvedPath) !== repoRoot) {
    throw new Error(
      `Reports must live directly under ${repoRoot}. Received: ${resolvedPath}`,
    );
  }

  const source = await readFile(resolvedPath, "utf8");

  if (!hasHtmlShell(source)) {
    throw new Error(`File does not look like valid HTML: ${resolvedPath}`);
  }

  if (!hasOverviewAnchor(source)) {
    throw new Error(
      `Missing id="${preferredAnchor}" in ${resolvedPath}. Add a stable landing section before previewing.`,
    );
  }

  return {
    filePath: resolvedPath,
    previewUrl: buildPreviewUrl(resolvedPath),
    artifactKind: getArtifactKind(resolvedPath),
  };
}
