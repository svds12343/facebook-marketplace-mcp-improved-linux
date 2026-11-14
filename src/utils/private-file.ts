import fs from "node:fs";
import path from "node:path";

/** Replace atomically, without exposing a partially written session or following a symlink. */
export function writePrivateJson(filename: string, value: unknown): void {
  const parent = path.dirname(filename);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryDirectory = fs.mkdtempSync(path.join(parent, ".fb-write-"));
  const temporaryFile = path.join(temporaryDirectory, "data.json");
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryFile, filename);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
