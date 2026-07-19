import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const aliasPlugin = {
  name: "alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) =>
      build.resolve("./src/" + args.path.slice(2), {
        resolveDir: root,
        kind: args.kind,
      })
    );
  },
};

const bundle = await build({
  entryPoints: [resolve(root, "src/lib/boot-armor.test.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
  plugins: [aliasPlugin],
});

const out = resolve(here, ".boot-armor-test.bundle.mjs");
writeFileSync(out, bundle.outputFiles[0].text);

let failure = null;
try {
  await import(pathToFileURL(out).href);
} catch (error) {
  failure = error;
} finally {
  rmSync(out, { force: true });
}

if (failure) {
  console.error(failure);
  process.exit(1);
}