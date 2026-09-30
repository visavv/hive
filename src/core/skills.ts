/**
 * Skills: reusable prompts with parameters, as plain markdown files.
 *
 *   ---
 *   name: yt-titles
 *   description: Title ideas from a transcript and your notes
 *   agent: claude              # default vendor (override per run)
 *   policy: reject-all         # chat-only by default: no file edits, no shell
 *   output: out/{name}-{date}.md   # optional: hive saves the reply here (relative to the folder)
 *   params:
 *     - name: transcript
 *       type: file             # text | file | number | choice
 *       required: true
 *       description: .txt/.srt/.vtt
 *     - name: count
 *       type: number
 *       default: 10
 *     - name: tone
 *       type: choice
 *       choices: [curious, bold, calm]
 *   ---
 *   Prompt text with {{transcript}} and {{count}}.
 *   {{#if notes}}My notes: {{notes}}{{/if}}
 *
 * Where skills come from (later ones override earlier ones with the same name):
 *   built-in   <hive>/skills/*.md
 *   user       <HIVE_HOME>/skills/*.md
 *   project    <repo>/.hive-skills/*.md   (commit these with your repo)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hiveHome, projectRoot } from "./home.js";
import type { PermissionPolicy } from "./session.js";

export type ParamType = "text" | "file" | "number" | "choice";

export interface SkillParam {
  name: string;
  type: ParamType;
  required?: boolean;
  default?: string;
  description?: string;
  choices?: string[];
}

export interface Skill {
  name: string;
  description: string;
  agent?: string;
  policy: PermissionPolicy;
  output?: string;
  params: SkillParam[];
  body: string;
  source: "built-in" | "user" | "project";
  path: string;
}

const MAX_FILE = 400_000;
const POLICIES = ["ask", "allow-reads", "allow-all", "reject-all"];

export function builtinSkillsDir(): string {
  // src/core or dist/core → <repo>/skills
  return fileURLToPath(new URL("../../skills/", import.meta.url));
}
export function userSkillsDir(): string {
  return join(hiveHome(), "skills");
}
export function projectSkillsDir(cwd: string): string {
  return join(projectRoot(cwd), ".hive-skills");
}

/** Parse a skill file (small YAML subset in the frontmatter). */
export function parseSkill(text: string, path = "", source: Skill["source"] = "user"): Skill {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${path || "skill"}: missing --- frontmatter ---`);
  const meta: Record<string, string> = {};
  const params: SkillParam[] = [];
  let inParams = false;
  let cur: Record<string, string> | undefined;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (!kv) throw new Error(`${path}: can't read line "${raw}"`);
      inParams = kv[1] === "params";
      if (!inParams) meta[kv[1]] = unquote(kv[2]);
      continue;
    }
    if (!inParams) continue;
    const item = line.match(/^\s*-\s+([\w-]+):\s*(.*)$/);
    const prop = line.match(/^\s+([\w-]+):\s*(.*)$/);
    if (item) {
      cur = { [item[1]]: unquote(item[2]) };
      params.push(cur as unknown as SkillParam);
    } else if (prop && cur) cur[prop[1]] = unquote(prop[2]);
    else throw new Error(`${path}: can't read param line "${raw}"`);
  }
  const name = meta.name || basename(path, ".md");
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error(`${path}: invalid skill name "${name}"`);
  const policy = (meta.policy || "reject-all") as PermissionPolicy;
  if (!POLICIES.includes(policy)) throw new Error(`${path}: unknown policy "${policy}"`);
  const ps: SkillParam[] = params.map((p: any) => {
    if (!p.name || !/^[\w-]+$/.test(p.name)) throw new Error(`${path}: every param needs a name`);
    const type = (p.type || "text") as ParamType;
    if (!["text", "file", "number", "choice"].includes(type)) throw new Error(`${path}: param ${p.name}: unknown type "${type}"`);
    return {
      name: p.name,
      type,
      required: p.required === "true",
      default: p.default,
      description: p.description,
      choices: p.choices ? parseList(p.choices) : undefined,
    };
  });
  return { name, description: meta.description ?? "", agent: meta.agent || undefined, policy, output: meta.output || undefined, params: ps, body: m[2].trim(), source, path };
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
function parseList(v: string): string[] {
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => unquote(x))
    .filter(Boolean);
}

/** All skills visible from `cwd` (project > user > built-in). */
export function listSkills(cwd: string): Skill[] {
  const by = new Map<string, Skill>();
  const dirs: [string, Skill["source"]][] = [
    [builtinSkillsDir(), "built-in"],
    [userSkillsDir(), "user"],
    [projectSkillsDir(cwd), "project"],
  ];
  for (const [dir, source] of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      const p = join(dir, f);
      try {
        const s = parseSkill(readFileSync(p, "utf8"), p, source);
        by.set(s.name, s);
      } catch (e: any) {
        by.set(basename(f, ".md"), {
          name: basename(f, ".md"),
          description: `⚠ ${e.message}`,
          policy: "reject-all",
          params: [],
          body: "",
          source,
          path: p,
        });
      }
    }
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(cwd: string, name: string): Skill {
  const s = listSkills(cwd).find((x) => x.name === name);
  if (!s) throw new Error(`no skill "${name}" (hive skill list)`);
  if (s.description.startsWith("⚠")) throw new Error(`skill ${name} is broken: ${s.description.slice(2)}`);
  return s;
}

/** Fill in a skill: validates params, reads file params, expands {{x}} and {{#if x}}…{{/if}}. */
export function renderSkill(s: Skill, values: Record<string, string>, cwd: string): string {
  const v: Record<string, string> = {};
  for (const p of s.params) {
    let val = values[p.name] ?? p.default ?? "";
    if (!val.trim()) {
      if (p.required) throw new Error(`missing required parameter "${p.name}"${p.description ? ` (${p.description})` : ""}`);
      v[p.name] = "";
      continue;
    }
    if (p.type === "number" && !Number.isFinite(Number(val))) throw new Error(`"${p.name}" must be a number, got "${val}"`);
    if (p.type === "choice" && p.choices?.length && !p.choices.includes(val))
      throw new Error(`"${p.name}" must be one of ${p.choices.join(", ")}, got "${val}"`);
    if (p.type === "file") {
      const path = isAbsolute(val) ? val : resolve(cwd, val);
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`"${p.name}": file not found: ${path}`);
      if (statSync(path).size > MAX_FILE) throw new Error(`"${p.name}": ${path} is larger than ${MAX_FILE / 1000} KB`);
      val = `(file: ${basename(path)})\n${readFileSync(path, "utf8")}`;
    }
    v[p.name] = val;
  }
  const unknown = Object.keys(values).filter((k) => !s.params.some((p) => p.name === k));
  if (unknown.length) throw new Error(`unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (skill takes: ${s.params.map((p) => p.name).join(", ") || "none"})`);
  let out = s.body.replace(/\{\{#if (\w[\w-]*)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, k, inner) => (v[k]?.trim() ? inner : ""));
  out = out.replace(/\{\{(\w[\w-]*)\}\}/g, (_, k) => v[k] ?? "");
  return out.trim();
}

/** Where to save a skill's output, if it declares one. */
export function outputPath(s: Skill, cwd: string, now = new Date()): string | undefined {
  if (!s.output) return undefined;
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const rel = s.output.replace(/\{name\}/g, s.name).replace(/\{date\}/g, stamp);
  const p = resolve(cwd, rel);
  // Stay inside the folder the skill ran in.
  if (!p.startsWith(resolve(cwd))) throw new Error(`skill output must stay inside ${cwd}`);
  return p;
}

export function saveOutput(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : text + "\n");
}

/** A starter skill file to edit. */
export function skillTemplate(name: string): string {
  return `---
name: ${name}
description: What this skill does, in one line
agent: claude
policy: reject-all
# output: out/{name}-{date}.md
params:
  - name: input
    type: text
    required: true
    description: The thing to work on
  - name: notes
    type: text
    description: Optional extra guidance
---
Do the task on the input below.

{{input}}

{{#if notes}}Keep in mind: {{notes}}{{/if}}
`;
}

/** Prompt for the skill-writer: turns a one-line description into a skill file. */
export function skillWriterPrompt(name: string, description: string): string {
  return `Write a hive skill file named "${name}" for this task: ${description}

A skill is a markdown file with YAML-like frontmatter and a prompt body. Format (follow exactly):

${skillTemplate(name)}
Rules:
- params: types are text, file (the file's contents are inserted), number, choice (with choices: [a, b, c]). Mark required ones "required: true". Give useful defaults.
- In the body use {{param}} to insert values and {{#if param}}...{{/if}} for optional parts.
- policy: reject-all for pure writing tasks; allow-reads if the task must read the project; never allow-all.
- Write a strong, specific prompt: the goal, the audience, the output format (e.g. a numbered list, a table), constraints and quality bar.
- Reply with ONLY the skill file, starting with --- and nothing after it.`;
}

/** Pull a skill file out of an agent reply (it may wrap it in a code fence). */
export function extractSkill(reply: string): string {
  const fence = reply.match(/```(?:markdown|md|yaml)?\s*\n(---[\s\S]*?)```/);
  const text = (fence ? fence[1] : reply.slice(reply.indexOf("---"))).trim();
  if (!text.startsWith("---")) throw new Error("the agent didn't return a skill file");
  return text + "\n";
}
