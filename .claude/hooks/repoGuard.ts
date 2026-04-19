import path from "node:path";
import { readFile } from "node:fs/promises";

if (process.env.CLAUDE_CODE_HARNESS_MODE === "1") {
  process.exit(0);
}

type HookInput = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  source?: string;
};

type ProjectContext = {
  code_root?: string;
  artifact_output_dir?: string;
  preferred_anchor?: string;
  docs_first?: string[];
};

const eventName = process.argv[2] ?? "";
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

async function loadProjectContext(): Promise<ProjectContext> {
  const contextPath = path.join(projectDir, "project-context.json");

  try {
    const raw = await readFile(contextPath, "utf8");
    return JSON.parse(raw) as ProjectContext;
  } catch {
    return {};
  }
}

function parseInput(raw: string): HookInput {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

function resolveMaybeRelative(baseDir: string, value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return path.resolve(baseDir, value);
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeSlash(input: string): string {
  return input.replaceAll("\\", "/");
}

function isScreenshotPreviewCommand(command: string): boolean {
  const normalized = normalizeSlash(command);
  const referencesHtml = normalized.includes(".html");
  if (!referencesHtml) {
    return false;
  }

  if (/\bbun\b[^\n]*\breport:(check|open)\b/.test(normalized)) {
    return false;
  }

  return /(playwright|puppeteer|screenshot|screencapture)/i.test(normalized);
}

function htmlAnchorMissing(content: unknown, anchor: string): boolean {
  if (typeof content !== "string") {
    return false;
  }

  return !new RegExp(`id=["']${anchor}["']`, "i").test(content);
}

function block(message: string): never {
  console.error(message);
  process.exit(2);
}

async function handleSessionStart(context: ProjectContext): Promise<void> {
  const codeRootPath = path.resolve(projectDir, context.code_root ?? ".");
  const artifactDir = path.resolve(projectDir, context.artifact_output_dir ?? ".");
  const preferredAnchor = context.preferred_anchor ?? "overview";
  const architectureDoc = context.docs_first?.[0] ?? "ARCHITECTURE.md";

  const additionalContext = [
    `Repo routing: the repo root for analysis is ${codeRootPath}.`,
    `Read ${path.join(projectDir, architectureDoc)} before broad discovery or technical deep dives.`,
    `Use "bun run repo:facts" for counts, hotspots, and LOC.`,
    `Treat ${path.join(projectDir, "archive", "launcher-root")} as historical context, not active source.`,
    `Write HTML reports and decks as direct children of ${artifactDir}.`,
    `Preview HTML with "bun run report:check ./file.html" and "bun run report:open ./file.html", ending at #${preferredAnchor}.`,
    `Prefer the direct local preview URL over screenshot tooling for the first verification pass.`,
  ].join(" ");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  );
}

async function handlePreToolUse(
  input: HookInput,
  context: ProjectContext,
): Promise<void> {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const artifactDir = path.resolve(projectDir, context.artifact_output_dir ?? ".");
  const preferredAnchor = context.preferred_anchor ?? "overview";
  const currentCwd = process.cwd();

  if (toolName === "Bash") {
    const command =
      typeof toolInput.command === "string" ? toolInput.command : "";

    if (isScreenshotPreviewCommand(command)) {
      block(
        `Screenshot-style HTML verification is blocked for this repo. Validate and preview local reports with "bun run report:check ./file.html" and "bun run report:open ./file.html" so the landing URL ends in #${preferredAnchor}.`,
      );
    }
  }

  if (toolName === "Write" || toolName === "Edit") {
    const filePath = resolveMaybeRelative(currentCwd, toolInput.file_path);
    if (!filePath || path.extname(filePath).toLowerCase() !== ".html") {
      return;
    }

    if (path.dirname(filePath) !== artifactDir) {
      block(
        `HTML reports and decks must be written as direct children of "${artifactDir}". This keeps local preview and validation deterministic.`,
      );
    }

    if (
      toolName === "Write" &&
      htmlAnchorMissing(toolInput.content, preferredAnchor)
    ) {
      block(
        `New HTML reports here must include id="${preferredAnchor}" so direct local previews can open at a stable landing section.`,
      );
    }

    if (!isSameOrInside(filePath, artifactDir)) {
      block(
        `HTML output path is outside the approved artifact directory: "${artifactDir}".`,
      );
    }
  }
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = parseInput(rawInput);
  const context = await loadProjectContext();

  if (eventName === "SessionStart") {
    await handleSessionStart(context);
    return;
  }

  if (eventName === "PreToolUse") {
    await handlePreToolUse(input, context);
  }
}

await main();
