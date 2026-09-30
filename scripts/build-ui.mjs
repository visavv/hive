// Bundles the pane UI into dist-ui/: electron main + preload (CJS) and the React renderer.
import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const out = "dist-ui";
mkdirSync(out, { recursive: true });
for (const f of ["index.html", "styles.css"]) copyFileSync(`src/ui/renderer/${f}`, `${out}/${f}`);

const common = { bundle: true, sourcemap: true, logLevel: "info" };
const configs = [
  { ...common, entryPoints: ["src/ui/electron-main.ts"], outfile: `${out}/main.cjs`, platform: "node", format: "cjs", external: ["electron"], target: "node20" },
  { ...common, entryPoints: ["src/ui/preload.ts"], outfile: `${out}/preload.cjs`, platform: "node", format: "cjs", external: ["electron"], target: "node20" },
  {
    ...common,
    entryPoints: ["src/ui/renderer/main.tsx"],
    outfile: `${out}/renderer.js`,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    minify: !watch,
  },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
