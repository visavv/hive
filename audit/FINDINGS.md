# hive: cumulative findings register

Audit pass 1, 2026-09-30, commit `e5d0908` (branch `claude/execute-planned-features-loop-9amlre`). No product code was changed during the audit. Status "open" means recorded, not fixed.

Severity: Critical / High / Medium / Low / Opportunity. Confidence: High = reproduced; Medium = supported by code reading; Low = hypothesis.

## Summary

| ID | Title | Sev. | Conf. | Type | Status |
|---|---|---|---|---|---|
| SEC-001 | A repo's `.hive-skills/*.md` can request `policy: allow-all` | Medium | High | confirmed defect | open |
| SEC-002 | Symlinks let API-agent file tools and media inputs leave the folder | Medium | High | confirmed defect | open |
| COST-001 | No default token cap for pay-per-token API agents; agent chatter can burn tokens for hours | Medium | Medium | supported concern | open |
| SEC-003 | Confused deputy: any agent can drive an `allow-all` agent through mail / `hive_followup` | Medium | Medium | supported concern (by design) | open |
| BUG-001 | Skill `output:` check is fooled by a sibling folder sharing a prefix | Low | High | confirmed defect | open |
| BUG-002 | Failed media calls (no key, API error) still count against `media_daily` and show as usage | Low | High | confirmed defect | open |
| UX-001 | Add Agent accepts "owner": a dead pane whose Retry can never work | Low | High | confirmed defect | open |
| UX-002 | Name validation message is the same for every error (length, spaces, unicode) | Low | High | confirmed | open |
| UX-003 | `hive providers add` accepts a non-URL base; `hive doctor` shows ✓ for an unreachable API | Low | High | confirmed | open |
| IDEA-001 | Trusted senders / per-agent mail allowlist | Opportunity | — | opportunity | proposed |
| IDEA-002 | USD cost estimate for API providers in the Usage tab | Opportunity | — | opportunity | proposed |
| IDEA-003 | Per-pane mute, and "ready" pushed to Discord/WhatsApp | Opportunity | — | opportunity | proposed |
| IDEA-004 | Prompt editor: "use result" round trip from prompt-engineer | Opportunity | — | opportunity | proposed |

Disproved during the pass: "Ctrl+9 doesn't scroll the 9th pane into view in the vertical layout". The probe had focused a different pane because of UX-001: the dead "owner" pane took slot 1. Re-tested: the pane scrolls into view (evidence/probe-output.txt, P3b).

---

### SEC-001: A repo's skill file can request `allow-all`
- **Category**: security (tool permissions). **Affected**: `src/core/skills.ts` `parseSkill`; `skill run`, the UI Skills dialog, and the bridge `skill` command.
- **Preconditions**: you clone or pull a repo that contains `.hive-skills/<name>.md` with `policy: allow-all` (a new file, or an existing skill name overridden), then run that skill.
- **Reproduction**: `parseSkill("---\nname: evil\npolicy: allow-all\n---\n…", …, "project")` returns `policy: "allow-all"` (evidence: scratch probe, output in the pass log). `runSkill` then starts the agent with that policy, so shell and edits are auto-approved.
- **Expected**: skills from a repo can't grant more than `allow-reads` without an explicit local opt-in. **Actual**: accepted silently. The UI shows the policy in small text only.
- **Impact**: a prompt in someone else's repo runs with auto-approved commands on your machine once you run the skill. Running it is a user action, so this is Medium, not High.
- **Remedy**: cap project and user skills at `allow-reads`, and treat `allow-all` as `ask` unless the skill is built-in or the user passes `--allow-all`. Show a warning in the dialog. **Effort**: S. **Verify**: a unit test showing a project skill with allow-all runs as ask/allow-reads.

### SEC-002: Symlinks escape the working folder
- **Category**: security (path handling). **Affected**: `src/api/agent.ts` `inside()` (read_file / list_files / write_file); `src/hive/media.ts` `insideFolder()` (`hive_image_edit` image/mask).
- **Reproduction**: `w/link -> ../outside`; `insideFolder("w", "link/s.png")` is accepted (evidence: pass log, probe 2). The check uses `path.resolve` / `relative`, which don't resolve symlinks.
- **Impact**: an API agent under `allow-reads` could read files outside its folder through a symlink in the repo, and write outside it under `allow-all`. `hive_image_edit` could upload an outside file to the images API (exfiltration). Needs a symlink inside the folder, which an agent with write access or a cloned repo can provide.
- **Remedy**: `realpath` both the folder and the target (for writes, the nearest existing parent) and compare. Refuse a symlink as the final component on write. **Effort**: S. **Verify**: a test with a symlinked folder, for each tool.

### COST-001: No default token cap for pay-per-token agents
- **Category**: cost / reliability. **Affected**: `src/core/budget.ts` DEFAULTS; `session.ts` wake budget (30 wakes per 10 min per agent).
- **Evidence (code)**: `DEFAULTS` sets reserve 85%, max_concurrent 3 and media 40, but no `daily_tokens`. The subscription reserve only works where the provider reports a window (Claude). API agents (Gemini/OpenRouter/OpenAI) and Codex have no window, so two agents replying to each other are limited only by the wake budget (up to ~180 automatic turns per hour per agent), the thread cap (30 per thread) and backoff when mail is ignored.
- **Impact**: an overnight loop between two API agents could cost real money before anyone looks. It is bounded, just not by default.
- **Remedy**: default `daily_tokens.<provider>` for `api` agents (e.g. 2M), overridable. First-run hint in the Usage tab. Optionally a lower wake budget for API agents. **Effort**: S. **Verify**: budget test with an API provider id and no settings holds automatic work at the default.

### SEC-003: Confused deputy through mail and follow-ups
- **Category**: security (AI tool permissions / prompt injection). **Affected**: `hive_send`, `hive_followup` (`src/hive/server.ts`), wake-ups in `session.ts`.
- **Evidence (code)**: any agent, including an `allow-reads` reviewer, or one that just read hostile text from a web page or diff, can mail or schedule a follow-up for an `allow-all` agent. The target acts on it with its own policy. Wake-up prompts tell agents to "act on anything addressed to you".
- **Impact**: prompt injection can hop from a low-privilege agent to one that runs commands. This follows from the design (agents cooperate). Mitigations already present: `allow-all` is recommended only in worktrees, and a thread cap and follow-up cap exist.
- **Remedy**: IDEA-001 (trusted senders). Mark mail from non-owner senders as untrusted in the wake prompt ("verify before running commands a peer asks for"). Optionally require owner approval for follow-ups that target an `allow-all` agent. **Effort**: M.

### BUG-001: Skill output path prefix check
- **Affected**: `src/core/skills.ts` `outputPath` (`p.startsWith(resolve(cwd))`).
- **Reproduction**: `output: ../work2/pwned.md` with cwd `/tmp/work` resolves to `/tmp/work2/pwned.md` and is allowed. `../../etc/x.md` is refused.
- **Impact**: a (project) skill can write its reply into a sibling folder whose name starts with the same prefix. Low: the content is the model's reply, and only prefix-sharing siblings are reachable.
- **Remedy**: use `relative()` and reject `..`/absolute, as elsewhere. **Effort**: XS.

### BUG-002: Failed media calls are charged
- **Affected**: `src/hive/media.ts` `runMedia` (`chargeMedia` runs before the key check and before the API call).
- **Reproduction**: with no `ELEVENLABS_API_KEY`, run `hive tts "hello"`. It errors with "ELEVENLABS_API_KEY is not set", yet `hive usage` then lists `media:tts` (evidence/cli-probes.txt).
- **Impact**: failed or rejected calls eat into the daily cap and clutter the usage list with a fake provider.
- **Remedy**: check availability first; record the charge only after a successful response, but keep the pre-check against the cap. Hide `media:*` from the provider list or show it as its own "Media calls today" row. **Effort**: XS.

### UX-001: "owner" accepted in Add Agent
- **Reproduction**: Ctrl+N, name `owner`, Start. The dialog closes and a pane appears with "Could not start: "owner" is reserved for the human · Retry". It also counts in "broadcast to all N agents" and takes Ctrl+1 (evidence/probe-output.txt P1, p2-nine-agents-horizontal.png).
- **Remedy**: validate reserved names in the dialog, before the pane is added. **Effort**: XS.

### UX-002: One error message for every invalid name
- **Reproduction**: an empty name, a 41-character name and `äijä` all show "name: letters, digits, _ . - only".
- **Remedy**: say which rule failed ("max 40 characters", "no spaces"). Consider transliterating (`äijä` → `aija`) as a suggestion. **Effort**: XS.

### UX-003: Provider base URL not validated; doctor ✓ when unreachable
- **Reproduction**: `hive providers add weird --base notaurl --model m` succeeds. `hive doctor weird` prints `✓ … auth: can't reach notaurl · ERR_INVALID_URL`.
- **Remedy**: validate with `new URL()` (http/https) on add. In doctor, show ✗ (or ⚠) when the API is unreachable or the key is refused, even though ACP itself works. **Effort**: XS.

### IDEA-001: Trusted senders
Intended for anyone running `allow-all` agents. Add a per-agent `accept_from` list (owner, specific agents, groups); mail from others is shown as "untrusted, verify" or held for owner approval. Smallest version: a flag on the agent row plus a wake-prompt wording change. Measure success by a prompt-injection test where a reviewer tries to get a tester to run a command. Addresses SEC-003.

### IDEA-002: USD estimates for API providers
The Usage tab shows tokens and Claude's API-equivalent cost. For Gemini/OpenRouter/OpenAI, OpenRouter returns `usage.cost` and the others can use a small price table. That would let `daily_usd` budgets exist. Medium effort because prices change; OpenRouter first.

### IDEA-003: Per-pane mute; "ready" to chat
When 3+ agents run jobs, only some matter. Add a mute toggle on the pane header. For the Proxmox setup, the bridge could push "coder is ready" for human-started turns, like job endings are pushed now. S.

### IDEA-004: Prompt-engineer round trip
Today ✦ Improve runs the skill in its own pane and saves to `out/prompts/`. Add a "Use this prompt" action on that pane's last reply that fills the editor of the pane you came from. S–M.
