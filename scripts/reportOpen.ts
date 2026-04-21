import { spawnSync } from "node:child_process";
import { validateReport } from "./reportUtils.js";

function openUrl(previewUrl: string): void {
  if (process.platform === "darwin") {
    const result = spawnSync("open", [previewUrl], { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`open exited with status ${result.status ?? "unknown"}`);
    }
    return;
  }

  if (process.platform === "linux") {
    const result = spawnSync("xdg-open", [previewUrl], { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`xdg-open exited with status ${result.status ?? "unknown"}`);
    }
    return;
  }

  if (process.platform === "win32") {
    const result = spawnSync("cmd", ["/c", "start", "", previewUrl], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`start exited with status ${result.status ?? "unknown"}`);
    }
    return;
  }

  throw new Error(`Unsupported platform for automatic preview: ${process.platform}`);
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const result = await validateReport(inputPath);

  openUrl(result.previewUrl);

  console.log(`Opened: ${result.previewUrl}`);
}

await main();
