import esbuild from "esbuild";
import builtins from "builtin-modules";
import { knightArrows } from "./build/knight-arrows.mjs";

const production = process.argv[2] === "production";

const banner = `/*
Chess Study for Obsidian. GPL-3.0-or-later.
Bundles chessground, chessops (GPL-3.0) and Stockfish.js 19 (GPL-3.0).
Source: see README.md
*/`;

const shared = {
  bundle: true,
  logLevel: "info",
  minify: production,
};

const js = await esbuild.context({
  ...shared,
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2020",
  treeShaking: true,
  sourcemap: production ? false : "inline",
  outfile: "main.js",
  loader: { ".wasm": "base64", ".worker.js": "text" },
  plugins: [knightArrows],
});

const css = await esbuild.context({
  ...shared,
  entryPoints: ["src/styles.css"],
  outfile: "styles.css",
  loader: { ".svg": "dataurl" },
});

if (production) {
  await Promise.all([js.rebuild(), css.rebuild()]);
  await Promise.all([js.dispose(), css.dispose()]);
} else {
  await Promise.all([js.watch(), css.watch()]);
}
