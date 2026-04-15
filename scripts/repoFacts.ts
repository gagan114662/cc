import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SourceFileStat = {
  relPath: string;
  topLevel: string;
  totalLines: number;
  nonEmptyLines: number;
};

type DirectorySummary = {
  files: number;
  totalLines: number;
  nonEmptyLines: number;
};

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const skipDirectoryNames = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".cache",
  ".turbo",
]);
const skipBasenames = new Set(["tmp-recover-cli.js"]);
const skipPathFragments = [
  `${path.sep}types${path.sep}generated${path.sep}`,
  `${path.sep}coverage${path.sep}`,
  `${path.sep}dist${path.sep}`,
  `${path.sep}node_modules${path.sep}`,
];
const skipFilePatterns = [
  /\.generated\.(ts|tsx|js|jsx|d\.ts)$/i,
  /\.d\.ts$/i,
  /\.map$/i,
];

function shouldSkipDirectory(dirName: string): boolean {
  return skipDirectoryNames.has(dirName) || dirName.startsWith("tmp-");
}

function shouldSkipFile(relPath: string, basename: string): boolean {
  if (skipBasenames.has(basename)) {
    return true;
  }

  if (skipPathFragments.some(fragment => relPath.includes(fragment))) {
    return true;
  }

  return skipFilePatterns.some(pattern => pattern.test(basename));
}

function getTopLevel(relPath: string): string {
  const [head] = relPath.split(path.sep);
  return head || "(root)";
}

async function collectSourceFiles(root: string): Promise<{
  scannedFiles: number;
  sourceFiles: SourceFileStat[];
}> {
  const sourceFiles: SourceFileStat[] = [];
  let scannedFiles = 0;
  const queue = [root];

  while (queue.length > 0) {
    const currentDir = queue.pop()!;
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relPath = path.relative(root, absolutePath);

      if (entry.isDirectory()) {
        if (
          relPath === path.join("types", "generated") ||
          relPath.startsWith(path.join("types", "generated") + path.sep)
        ) {
          continue;
        }

        if (shouldSkipDirectory(entry.name)) {
          continue;
        }
        queue.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (shouldSkipFile(relPath, entry.name)) {
        continue;
      }

      scannedFiles += 1;

      const extension = path.extname(entry.name).toLowerCase();
      if (!sourceExtensions.has(extension)) {
        continue;
      }

      const source = await readFile(absolutePath, "utf8");
      const lines = source.split(/\r?\n/);
      const totalLines = lines.length;
      const nonEmptyLines = lines.filter(line => line.trim().length > 0).length;

      sourceFiles.push({
        relPath,
        topLevel: getTopLevel(relPath),
        totalLines,
        nonEmptyLines,
      });
    }
  }

  return { scannedFiles, sourceFiles };
}

function summarizeDirectories(sourceFiles: SourceFileStat[]): Map<string, DirectorySummary> {
  const summary = new Map<string, DirectorySummary>();

  for (const file of sourceFiles) {
    const current = summary.get(file.topLevel) ?? {
      files: 0,
      totalLines: 0,
      nonEmptyLines: 0,
    };

    current.files += 1;
    current.totalLines += file.totalLines;
    current.nonEmptyLines += file.nonEmptyLines;
    summary.set(file.topLevel, current);
  }

  return summary;
}

async function main(): Promise<void> {
  const root = await realpath(repoRoot);
  const { scannedFiles, sourceFiles } = await collectSourceFiles(root);
  const directorySummary = summarizeDirectories(sourceFiles);
  const totalLines = sourceFiles.reduce((sum, file) => sum + file.totalLines, 0);
  const totalNonEmptyLines = sourceFiles.reduce(
    (sum, file) => sum + file.nonEmptyLines,
    0,
  );

  const dominantDirectories = [...directorySummary.entries()]
    .sort((left, right) => {
      if (right[1].files !== left[1].files) {
        return right[1].files - left[1].files;
      }
      return right[1].totalLines - left[1].totalLines;
    })
    .slice(0, 10);

  const largestFiles = [...sourceFiles]
    .sort((left, right) => right.totalLines - left.totalLines)
    .slice(0, 12);

  console.log(`Repo facts for ${root}`);
  console.log(
    "Excluded: node_modules, dist, coverage, types/generated, *.generated.*, *.d.ts, *.map, tmp-* dirs, tmp-recover-cli.js",
  );
  console.log("");
  console.log(`Files scanned: ${scannedFiles}`);
  console.log(`Source files analyzed: ${sourceFiles.length}`);
  console.log(`Total source LOC: ${totalLines}`);
  console.log(`Non-empty source LOC: ${totalNonEmptyLines}`);
  console.log("");
  console.log("Dominant directories (source files / LOC / non-empty LOC)");

  for (const [directory, summary] of dominantDirectories) {
    console.log(
      `- ${directory}: ${summary.files} files / ${summary.totalLines} LOC / ${summary.nonEmptyLines} non-empty LOC`,
    );
  }

  console.log("");
  console.log("Largest source files");

  for (const file of largestFiles) {
    console.log(
      `- ${file.relPath}: ${file.totalLines} LOC / ${file.nonEmptyLines} non-empty LOC`,
    );
  }
}

await main();
