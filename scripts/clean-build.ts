import { access, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await rm(resolve(workspaceRoot, "dist"), { recursive: true, force: true });

for (const group of ["extensions", "packages"]) {
  const root = resolve(workspaceRoot, group);
  if (!(await pathExists(root))) continue;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await rm(resolve(root, entry.name, "dist"), { recursive: true, force: true });
  }
}
