/** Skills: parsing, rendering, validation, running through the hub, saving output, skill writer. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import { builtinSkillsDir, findSkill, listSkills, parseSkill, projectSkillsDir, renderSkill } from "../src/core/skills.js";
import { runSkill, writeSkill } from "../src/core/skill-run.js";
import { assert, finish, freshDir } from "./util.js";

const dir = freshDir(".hive-test-skills");
const work = freshDir(join(dir, "work"));
process.env.HIVE_HOME = join(dir, "home");

// every built-in parses
const files = readdirSync(builtinSkillsDir()).filter((f) => f.endsWith(".md"));
const broken = files.filter((f) => {
  try {
    parseSkill(readFileSync(join(builtinSkillsDir(), f), "utf8"), f, "built-in");
    return false;
  } catch (e: any) {
    console.error(e.message);
    return true;
  }
});
assert(files.length >= 8 && broken.length === 0, `all ${files.length} built-in skills parse`);

// rendering
writeFileSync(join(work, "t.txt"), "today we build a robot that folds laundry and it fails twice");
const yt = findSkill(work, "yt-titles");
assert(yt.params.find((p) => p.name === "transcript")?.type === "file" && yt.params.find((p) => p.name === "count")?.default === "12", "frontmatter params read (types, defaults)");
const prompt = renderSkill(yt, { transcript: "t.txt", notes: "the fail is the point" }, work);
assert(prompt.includes("folds laundry") && prompt.includes("Write 12 title options") && prompt.includes("the fail is the point"), "file param inlined, defaults and values filled");
assert(!prompt.includes("Current working title") && !prompt.includes("{{"), "{{#if}} drops empty optional sections, no leftovers");
const err = (f: () => unknown) => {
  try {
    f();
    return "";
  } catch (e: any) {
    return e.message as string;
  }
};
assert(/missing required parameter "transcript"/.test(err(() => renderSkill(yt, {}, work))), "missing required param is a clear error");
assert(/file not found/.test(err(() => renderSkill(yt, { transcript: "nope.txt" }, work))), "missing file is a clear error");
assert(/unknown parameter titel/.test(err(() => renderSkill(yt, { transcript: "t.txt", titel: "x" }, work))), "typo'd param names are rejected");
assert(/must be one of/.test(err(() => renderSkill(findSkill(work, "pr-description"), { agent: "a", audience: "cats" }, work))), "choice params are validated");

// project skill overrides built-in
execFileSync("git", ["init", "-q"], { cwd: work });
mkdirSync(projectSkillsDir(work), { recursive: true });
writeFileSync(join(projectSkillsDir(work), "yt-titles.md"), "---\nname: yt-titles\ndescription: my own\n---\nmine {{x}}\n");
assert(findSkill(work, "yt-titles").source === "project" && listSkills(work).filter((s) => s.name === "yt-titles").length === 1, "project skills override built-ins");
writeFileSync(join(projectSkillsDir(work), "bad.md"), "no frontmatter");
assert(listSkills(work).find((s) => s.name === "bad")?.description.startsWith("⚠"), "a broken skill file is listed with its error, not crashing the list");

// run through the hub (mock agent), output saved
const hub = new Hub({ hiveDb: join(dir, "hive.db") });
const custom = parseSkill("---\nname: t2\ndescription: test\nagent: mock\noutput: out/{name}-{date}.md\nparams:\n  - name: transcript\n    type: file\n    required: true\n---\nWrite 3 title options for:\n{{transcript}}\n", "t2.md");
const r = await runSkill(hub, custom, { transcript: "t.txt" }, { cwd: work });
assert(!r.result.error && r.reply.includes("A title") && r.agent === "skill-t2", "skill runs in its own agent and returns the reply");
assert(r.saved && existsSync(r.saved) && readFileSync(r.saved, "utf8").includes("A title"), "skill output saved to the declared file");
const sentPrompt = hub.db.events(0, 100000).filter((e) => e.agent === "skill-t2" && e.type === "prompt").map((e) => JSON.parse(e.data).text).pop() ?? "";
assert(sentPrompt.includes("folds laundry"), "the rendered prompt reached the agent");
assert(hub.db.getAgent("skill-t2")?.policy === "reject-all", "skills run chat-only (reject-all) by default");

// skill writer
const text = await writeSkill(hub, "blog-outline", "outline a blog post", { cwd: work, kind: "mock" });
const s = parseSkill(text, "blog-outline.md");
assert(s.name === "blog-outline" && s.params[0]?.name === "topic", "skill writer returns a valid skill file from a description");
await hub.close();
finish("skills");
