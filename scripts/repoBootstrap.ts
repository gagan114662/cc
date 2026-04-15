import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type ProjectContext = {
  code_root?: string;
  docs_first?: string[];
  artifact_output_dir?: string;
  artifact_reference_files?: string[];
  preferred_anchor?: string;
  validation_commands?: Record<string, string>;
};

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function loadProjectContext(): Promise<ProjectContext> {
  const contextPath = path.join(repoRoot, "project-context.json");
  const raw = await readFile(contextPath, "utf8");
  return JSON.parse(raw) as ProjectContext;
}

function toAbsolute(target: string): string {
  return path.resolve(repoRoot, target);
}

async function main(): Promise<void> {
  const context = await loadProjectContext();
  const preferredAnchor = context.preferred_anchor ?? "overview";
  const docsFirst = (context.docs_first ?? []).map(toAbsolute);
  const artifactDir = toAbsolute(context.artifact_output_dir ?? ".");
  const referenceArtifacts = (context.artifact_reference_files ?? []).map(toAbsolute);

  console.log("Repo bootstrap");
  console.log(`Repo root: ${repoRoot}`);
  console.log("Code root: repo root");
  console.log("");
  console.log("Read first:");
  for (const doc of docsFirst) {
    console.log(`- ${doc}`);
  }
  console.log("");
  console.log("First commands:");
  console.log(`- bun run repo:facts`);
  console.log(`- bun run report:check ./<report>.html`);
  console.log(`- bun run report:open ./<report>.html`);
  console.log("");
  console.log("HTML report rules:");
  console.log(`- Write new reports as direct children of ${artifactDir}`);
  console.log(`- Include id=\"${preferredAnchor}\" in new reports`);
  console.log(`- Prefer file:///...#${preferredAnchor} over screenshot verification`);
  console.log("");
  console.log("Reference artifacts:");
  for (const artifact of referenceArtifacts) {
    console.log(`- ${artifact}`);
  }
  console.log("");
  console.log("Preview example:");
  console.log(
    `- ${pathToFileURL(path.join(repoRoot, "session-transcript.html")).href}#${preferredAnchor}`,
  );
}

await main();
