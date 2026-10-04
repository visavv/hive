/** Teamwork helpers: who leads a team broadcast, what the lead and the others are told. */
import { assert, finish } from "./util.js";
import { LEAD_MARK, leadPrompt, pickLead, TEAM_POLICY, waitNotice } from "../src/core/team.js";

const team = [
  { name: "zucchini", role: "coder", policy: "ask" },
  { name: "bongo", role: "general assistant", policy: "reject-all" },
  { name: "wombat", role: "code reviewer", policy: "allow-reads" },
  { name: "pickle", role: "improvement finder", policy: "allow-reads" },
];
assert(pickLead(team)?.name === "zucchini", "a coder leads when there is no planner");
assert(pickLead([...team, { name: "boss", role: "tech lead / planner", policy: "ask" }])?.name === "boss", "a planner/lead role leads first");
assert(pickLead([team[1], team[2]])?.name === "wombat", "a chat-only agent never leads while someone else can act");
assert(pickLead([team[1]])?.name === "bongo", "…unless it's the only one");
const p = leadPrompt("make memento mori calendar", team[0], team);
assert(p.startsWith(LEAD_MARK) && p.includes("Task: make memento mori calendar") && p.includes("wombat (code reviewer)") && !p.includes("Teammates: zucchini"), "the lead's prompt carries the task and its teammates");
assert(/waits for its part by mail/.test(waitNotice("x", team[0])), "the others are told they wait for the lead");
assert(/asks the owner which to do/.test(TEAM_POLICY) && /hive names one lead/.test(TEAM_POLICY), "every agent's briefing explains team broadcasts and the improvements → coder → owner flow");
// the improvements → coder → owner flow is wired through the presets' briefings (the model does the rest)
const { ROLES } = await import("../src/core/roles.js");
assert(/hive_send it the new ideas/.test(ROLES.scout.briefing ?? "") && /coder agent exists/.test(ROLES.scout.briefing ?? ""), "the scout preset sends new ideas to the coder");
assert(/don't build them yet/.test(ROLES.coder.briefing ?? "") && /ask the owner which to do/.test(ROLES.coder.briefing ?? ""), "the coder preset asks the owner before building suggested ideas");
finish("team");
