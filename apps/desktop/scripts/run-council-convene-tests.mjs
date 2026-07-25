// Runner sem esbuild — helpers são TS puro (Node 22+ strip-types).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const testFile = resolve(here, "../src/lib/council-convene.test.ts");
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", testFile],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
