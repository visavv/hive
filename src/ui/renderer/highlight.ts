/**
 * Syntax highlighting for the code view: highlight.js core with a curated set
 * of languages registered explicitly (the full bundle is ~1 MB; this is a
 * fraction of it). Output is split into one HTML string per line so the view
 * can number, select and colour lines individually.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";

const LANGS = { bash, c, cpp, csharp, css, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml, diff };
for (const [name, fn] of Object.entries(LANGS)) hljs.registerLanguage(name, fn);

const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", pyw: "python",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "bash",
  yml: "yaml", yaml: "yaml", toml: "yaml",
  go: "go", rs: "rust", java: "java", kt: "java",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", sql: "sql", diff: "diff", patch: "diff",
};
const BY_NAME: Record<string, string> = { dockerfile: "bash", makefile: "bash", ".bashrc": "bash", ".zshrc": "bash", ".gitignore": "bash", ".env": "bash" };

/** The highlight.js language for a file name, or undefined (plain text). */
export function langOf(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop()!.toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return BY_EXT[ext];
}

/** Short label for the code fence in prompts ("ts", "py"…). */
export function fenceOf(path: string): string {
  const ext = path.split(/[\\/]/).pop()!.split(".").pop()!.toLowerCase();
  return /^[a-z0-9+#-]{1,10}$/.test(ext) && path.includes(".") ? ext : "";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Files bigger than this are shown without colours (highlighting would stall the window). */
const MAX_HIGHLIGHT = 400_000;

/** Highlighted HTML per line (escaped plain text when the language is unknown or the file is huge). */
export function highlightLines(text: string, lang: string | undefined): string[] {
  if (!lang || text.length > MAX_HIGHLIGHT || !hljs.getLanguage(lang)) return text.split("\n").map(esc);
  try {
    return splitHtmlLines(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value);
  } catch {
    return text.split("\n").map(esc);
  }
}

/** Highlight one line on its own (diff rows: each line is coloured without its neighbours). */
export function highlightLine(line: string, lang: string | undefined): string {
  if (!lang || !hljs.getLanguage(lang) || line.length > 2000) return esc(line);
  try {
    return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return esc(line);
  }
}

/**
 * Split highlight.js HTML at newlines. A token can span lines (block comments,
 * template strings), so spans still open at a newline are closed at the end of
 * that line and reopened at the start of the next.
 */
export function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else if (m[3]) {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else cur += m[4];
  }
  lines.push(cur + "</span>".repeat(open.length));
  return lines;
}
