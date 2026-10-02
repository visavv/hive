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
finish("team");
