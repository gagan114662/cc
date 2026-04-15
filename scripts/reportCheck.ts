import { validateReport } from "./reportUtils.ts";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const result = await validateReport(inputPath);

  console.log(`OK: ${result.filePath}`);
  console.log(`Artifact kind: ${result.artifactKind}`);
  console.log(`Preview URL: ${result.previewUrl}`);
}

await main();
