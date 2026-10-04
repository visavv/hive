# hive: cumulative findings register

Cumulative register for passes 1–5 (passes 1–3 on branch `claude/execute-planned-features-loop-9amlre`). Pass 1 changed no product code. In passes 2 and 3, fixes were authorized and are listed per finding. The detailed write-ups below are from pass 1 unless marked otherwise; their "Remedy" sections are what was implemented.

Severity: Critical / High / Medium / Low / Opportunity. Confidence: High = reproduced; Medium = supported by code reading; Low = hypothesis.

## Summary

Passes: 1 (2026-09-30, commit e5d0908); 2 and 3 (2026-10-01, commits a4f18dc → dbd173d); 4 = fix round for the remaining items (2026-10-01); 5 = security, terminal UI, CLI and setup-script review (2026-10-01, see [Pass 5](#pass-5-2026-10-01)). Fixes were authorized in pass 2 ("now fix audit gaps"), so each finding records what changed and which test verifies it. A finding is "fixed" only after a test or a hands-on re-check passed on the fixed code.

| ID | Title | Sev. | Conf. | Found | Status (pass 3) | Verified by |
|---|---|---|---|---|---|---|
| SEC-001 | A repo's skill file can request `allow-all` | Medium | High | 1 | **fixed**: only built-in skills may run allow-all; others run as `ask`, and the CLI says so | test/fixes.ts |
| SEC-002 | Symlinks escape folder confinement (API agent file tools, media inputs, skill output) | Medium | High | 1 | **fixed**: realpath-based `confine()` | test/fixes.ts (symlink, new file under symlink, `..` false positive) |
| COST-001 | No default token cap for pay-per-token agents | Medium | Medium | 1 | **fixed**: `daily_tokens_api` default 2M per API provider for automatic work; `daily_tokens.<p>=0` turns it off | test/fixes.ts |
| SEC-003 | Peer mail / follow-ups can drive an `allow-all` agent | Medium | Medium | 1 | **fixed (pass 4)**: untrusted wrapping + trust policy (pass 2), and now mail from an unlinked agent to an allow-all agent is **held for your review** by default (Inbox: Release / Edit / Drop / Link & release); linked agents talk directly | test/links.ts (guard), UI test (Inbox lists held mail) |
| SEC-004 | `allow-all` agents run as you and can edit hive's own database/settings (insert "owner" mail, unpause budgets) | Medium | Medium | 3 | **mitigated (pass 4)**: warnings when choosing allow-all without a worktree (Add Agent dialog, CLI); peer mail to allow-all agents held (SEC-003). Residual, by design: an agent you let run any command can still do anything you can; only an OS sandbox would stop that | UI dialog, CLI note |
| BUG-001 | Skill output check fooled by a prefix-sharing sibling folder | Low | High | 1 | **fixed** | test/fixes.ts |
| BUG-002 | Failed media calls counted against the cap | Low | High | 1 | **fixed**: counted only on success; media shown as its own row | test/media.ts |
| BUG-003 | Deleting a group strands its held messages (invisible in the UI, never delivered) | Medium | High | 2 | **fixed**: delete refused until held mail is released or dropped (UI toast, CLI hint) | test/fixes.ts; UI probe (evidence/probe2-after-fixes.txt) |
| BUG-004 | Media jobs left "running" after a crash keep callers waiting up to 6 min, until pruned a day later | Low | Medium | 2 | **fixed**: failed on hub start | test/fixes.ts |
| UX-001 | Add Agent accepted "owner" (dead pane) | Low | High | 1 | **fixed**: reserved names checked in the dialog and hub | UI probe P1 (pass 2) |
| UX-002 | One error message for every invalid name | Low | High | 1 | **fixed**: one message per rule | test/fixes.ts; UI probe |
| UX-003 | Provider base not validated; doctor ✓ when unreachable | Low | High | 1 | **fixed** (URL validation; doctor shows `!` with a sign-in hint) | test/fixes.ts; `hive accounts` output |
| UX-004 | Pane header overflows at narrow widths (3–4 columns): chips wrap, model select clipped, close button cut off | Medium | High | 2 | **fixed**: container queries; name ellipsis; lower-priority items hide by width | UI probe screenshot p2-layout-1920-3cols.png (after fix) |
| UX-005 | 🔗 Link dialog kept the first agent's name as the group name ("@coder") | Low | High | 2 | **fixed**: default name follows members until you type one | UI probe ("@coder-reviewer") |
| UX-006 | ⏸ glyph renders as a box on Linux fonts (group chip, usage pause, held bar) | Low | High | 2 | **fixed**: inline SVG icon | screenshots |
| A11Y-001 | Dialogs don't keep keyboard focus (Tab reaches the page behind) | Medium | High | 3 | **fixed**: focus trap + focus restore in Modal | UI probe: 0 escapes in 25 Tabs (was 20) |
| A11Y-002 | Toasts not announced to screen readers | Low | High | 3 | **fixed**: `role=status aria-live=polite`; errors `role=alert` | UI probe |
| PRIV-001 | Mail, API-agent conversations and caption cache kept forever | Low | High | 2 | **fixed**: read mail >90 days pruned (unread/held kept); api-sessions and caption cache files >30 days deleted | test/fixes.ts |
| PERF-001 | Unread counts scan messages (~2.4 ms per agent at 20k messages; pushed every second) | Low | High | 3 | **fixed (pass 4)**: unread query split into indexed halves (0.67 ms, 3.5× faster); partial indexes for held/via; group chat query as a union of indexed lookups | evidence/perf-bench.txt → perf-bench-after.txt |
| UX-007 | Desktop entry: a `%` in the project path breaks the launcher | Low | Medium | 3 | **fixed**: `%` escaped as `%%` | code reading |
| UX-008 | Toasts sit over the bottom-left composer for 4 s | Low | High | 3 | **fixed (pass 4)**: top-center under the bar, click-through | UI test |
| UX-009 | Top bar labels wrapped onto two lines at ≤1600 px after the Verdict button was added | Low | High | 4 | **fixed**: no-wrap; lower-priority items collapse by window width | probe at 1366/1280 (topbar 40 px, nothing clipped) |
| IDEA-001 | Trusted senders / per-agent accept list | Opportunity | — | 1 | **done as**: links = trusted senders (allow-all guard + only-linked scope + review mode) | test/links.ts |
| IDEA-002 | USD estimates for API providers | Opportunity | — | 1 | proposed | — |
| IDEA-003 | Per-pane mute; "ready" pushed to chat bridges | Opportunity | — | 1 | proposed | — |
| IDEA-004 | Prompt-engineer "use this prompt" round trip | Opportunity | — | 1 | proposed | — |
| IDEA-005 | Chain on "agent finished" (fan-out/fan-in), as Maestro Cue does | Opportunity | — | 3 | proposed | docs/COMPARISON.md |
| IDEA-006 | Copy `.env` / untracked files into new worktrees (`.worktreeinclude`) | Opportunity | — | 3 | proposed | docs/COMPARISON.md |
| IDEA-007 | Best-of-n: one skill on several models, compared blind | Opportunity | — | 3 | **done**: verdict mode (docs/VERDICT.md) | test/verdict.ts, UI test |

Disproved: pass 1 suspected "Ctrl+9 doesn't scroll in vertical layout". The cause was UX-001; Ctrl+9 works.

## Pass 6 (2026-10-04): UI coherence, control-by-control value, orchestration workflows

Review on 2026-10-04, fix round the same day (see "Pass 6 fixes" below). Method: the demo session (`test/showcase.ts`, mock agents in demo mode), a scenario script (dialogs, six agents, 1280×720 and 1920×1080, 3 columns, a 25-turn transcript, every drawer tab, light theme, 120 % zoom), the existing UI test (passes), and a code trace of the control inventory, the agent state model and `styles.css`. **Only the mock agent was exercised; no real vendor is signed in on this machine.** Evidence: `audit/evidence/pass6/`, `docs/screenshots/` (regenerated).

### Assessment

The pane grid, palette and "Worked for" fold are close to T3 Code and herdr, and the main journeys (team broadcast, mail hand-off, review groups, jobs, ✦ improve, dictation with a fake server) work in the UI test. What doesn't hold up is the layer under them: `styles.css` has grown as five override passes on top of each other, so earlier fixes silently stopped applying (UX-004 regressed), the four agent states are computed in four places with different rules, and roughly a third of the controls are duplicates of another control. Narrow panes (3 columns, the docked Hive panel, 1280 px windows) are where the UI melts: headers clip, tables break into syllables, the panel's tabs wrap to three lines.

### Register

| ID | Title | Sev. | Conf. | Verdict |
|---|---|---|---|---|
| BUG-005 | **UX-004 regressed**: pane header clips at narrow widths again (role badge, context meter, state pill and the "idle 15s" text cut off at 3 columns / 1280 px and beside the docked Hive panel) because the container-query rules at `styles.css:362/368` (`.kind`, `.ctx` hidden) are overridden by the later unconditional `display: inline-flex` at :682 | High | High (screenshots r08, drawer-docked) | fix: move the hide rules after the alignment pass, or scope them with higher specificity; re-add the 3-column probe to `test/ui.ts` |
| BUG-006 | Markdown tables inside a transcript break words into syllables at pane widths under ~450 px ("Hig h", "Med ium", "limite r.ts:27") | Medium | High (drawer-docked.png) | fix: `white-space: nowrap` on the first/last columns and `overflow-x: auto` on `.md table` wrappers |
| BUG-007 | Docked Hive panel: the seven tabs wrap onto two rows and "Since you left" onto three lines at the default dock width (640 px) | Medium | High | fix: shorter tab labels ("Report", "Inbox", "Learn", "Board", "Mail", "Usage", "Accounts") or an overflow menu; dock width min 560 |
| BUG-008 | The "undo" button after ✦ improve is squeezed to 30 px wide: `.composer-bar > button.ghost` (0,2,1) at :1226 beats `.composer-bar .improve-undo { width: auto }` (0,2,0) at :1233. The same specificity order kills the ✦ accent hover at :1232 | Medium | High (code) | fix: give the composer rules one specificity level; drop the `>` child combinator |
| BUG-009 | Palette command "Zoom in / out / reset" does nothing (`run: () => {}`, App.tsx:231): picking it closes the palette and that's all | Low | High | fix: make it zoom in, and list Ctrl+- / Ctrl+0 in the hint; or remove it |
| BUG-010 | Ctrl+J opens the board but can't close it: the overlay gate (App.tsx:128-134) only lets Ctrl+K and Ctrl+I through while an overlay is on top. Ctrl+Shift+M / Ctrl+Shift+I also trigger maximize / drawer (no Shift check) | Low | High | fix: add `board`+J to `closesTop`; check `!e.shiftKey` on M and I |
| BUG-011 | An agent that calls `hive_status({status:"waiting"})` turns its pane to **needs you** with nothing to answer, until its next status write; the window title and the ready button ignore it, so the header and the title disagree | Medium | High (code: state.tsx:25 vs App.tsx:107) | fix: derive "needs you" from open asks only; show a tool-set "waiting" as a note |
| BUG-012 | "asleep" agents have no branch in `agentState`, so a closed session shows **done** or **idle** for up to a second, then flips to **stopped** when it leaves the snapshot; `OtherAgents` and `format.ts statusLabel` use their own raw-status tables | Low | Medium | fix: one `agentState` for every surface; map asleep → stopped |
| BUG-013 | The window title counts only open cards and ready marks; an agent in **error** or the tool-set waiting state never shows in the title, although the sidebar and palette show it | Low | High | fix: use `rollup()` as the comment at state.tsx:34 already intends |
| BUG-014 | Palette rows can show a stale state while the palette is open: `items` is memoised on `[q, names, actions]` (Palette.tsx) | Low | Medium | fix: include the states in the deps or read them in render |
| BUG-015 | `.pane.ready` (done panes) gets a *weaker* border than idle panes: :610 sets `border-color: var(--border)` after the contrast pass set `--border-strong` for every pane; `.pane.linked` gets a mismatched left edge from :440 | Low | High | fix: remove the two leftovers |
| BUG-016 | Every dark theme's hand-picked `--border`, `--border-strong` and `--text-3` are dead: `:root:not([data-tone="light"])` at :1242 (same specificity, later) replaces them with a colour-mix | Low | High | fix: compute the mix once per theme, or move :1242 before the theme blocks |
| BUG-017 | Accounts tab shows two loading lines at once ("checking…" and "checking each agent (a few seconds)…") | Low | High (r06-drawer-accounts) | fix: one |
| UX-010 | **Design tokens are defined four times** (`:root` at :1, :406, :515, :669) with aliases that trap authors: `--bg3` is `--bg-2`, not `--bg-3`, so hover uses two different shades (:64 vs :772); `var()` fallbacks disagree with the tokens (`--r-3, 10px` while `--r-3` is 8px); `--bg-4` is defined in every theme and never used; `--magenta` is never themed | Medium | High | fix: one `:root` block with the new names; delete the old aliases after a rename pass |
| UX-011 | **No type or size scale**: 14 distinct font sizes (five between 10 and 12.5 px), pills built five ways (8, 9, 10, 999 px, calc), control heights 18/20/22/26/28/30/34, two icon classes with different baselines (`.ico` −1 px, `.icon` −3 px), `.pane-head .st` set to 20 px and 18 px in the same pass (:682 vs :691) | Medium | High | fix: tokens `--fs-1..4`, `--h-ctl` 28 / `--h-chip` 20 / `--h-icon` 30, one `.pill` class, one icon class |
| UX-012 | **Five state-indicator systems** coexist: `.dot.*` (sidebar legacy, `pulse` easing), `.st-*` (pills, `hive-pulse` steps), `.badge.ready`, `.vc/.vstat` (verdict), `.kb-dot-*` (board), `.voice-badge` (`voice-pulse`); the same state has different dot sizes (6/7/8 px) and animations | Medium | High | fix: one `StatePill`/dot component and one keyframe, used by sidebar, palette, board and verdict |
| UX-013 | Pane header carries up to 11 items (checkbox, index, name, kind, role badge, group chip, context meter, state pill, queued badge, job badge, 7 action icons). herdr shows name + state. Kind ("claude-code") is 10 px grey text nobody reads; role badge and group chip are both pills and read as the same thing | Medium | High (03-squad) | fix: name · role badge · state pill in the header; kind, branch, policy, idle time, context in the sub row; actions behind one "…" menu except Stop and Maximize |
| UX-014 | Top bar has 13 controls. "Team / Each" is a highlighted toggle next to Send and reads as an app-wide mode; "✓ 2 ready" is the only green button; "Usage" is a chip whose meaning is unclear until hovered | Medium | Medium | fix: Team/Each as a small select inside the broadcast box; Verdict and Board into the palette only (both are in it already); keep ☰, broadcast, ready, bell, columns, Hive, + Agent |
| UX-015 | Composer placeholder does two jobs: "message planner… ✦ improves a rough idea". While working it changes to "agent is working — Enter queues, Esc cancels", so the box's own name disappears | Low | High | fix: "message planner…" only; ✦ hint in the button's tooltip; working state shown as a small line above the box |
| UX-016 | Tool rows repeat the verb: "read **Read** src/api/client.ts", "execute npm test". T3 Code shows one verb. While a turn is running each tool is a full bordered card; only after the turn do they fold | Low | High (05-focus-coder) | fix: drop the kind label when the title starts with the same verb; render in-flight tools as the same compact lines the fold uses |
| UX-017 | Duplicate controls with the same effect: sidebar toggle ×4 (Ctrl+B, Ctrl+\, ☰, palette), pane cycle ×2 pairs, link agents ×6 entry points, verdict ×5, "Retry" and "Restart (resumes the session)" call the same function, chime toggle in two places with slightly different behaviour | Low | High | verdicts: keep Ctrl+B + ☰, drop Ctrl+\; keep Ctrl+Tab, drop Ctrl+Shift+[ ]; one "Retry"; one Verdict button; link via drag + pane icon + Group N |
| UX-018 | Three dialogs have no Close/Cancel button (Token stats, Group chat, Verdict view); `CardEditor` builds its own modal without the focus trap; `Modal` renders no ✕ | Low | High | fix: ✕ in `Modal` for all |
| UX-019 | "Delete group" (red) sits next to "Send" in the group chat; one mis-click away | Low | High (07-group-chat) | fix: move to a "…" menu or the top-right with a confirm |
| UX-020 | Sidebar job card wording is a sentence fragment: "agent branches (hive/*) ≥40 lines or any change after 20m, at most every 5m · 0 runs" | Low | High | fix: two lines: "watch · agent branches" / "≥40 lines or 20 min · every 5 min · 0 runs" |
| UX-021 | Add agent "Model" field placeholder is a paragraph ("default (or type a model name; the list fills in once this agent has…") and gets cut off | Low | High (r02) | fix: placeholder "default"; the explanation as a hint line under the field |
| UX-022 | Clickable rows without keyboard access or a role: group `li` (Links.tsx:340), mail rows (Drawer.tsx:374), stats rows (Stats.tsx:93); the "fresh session" button has no aria-label; `.dot` / `voice-pulse` / `.improve.busy` animations have no reduced-motion guard | Low | High | fix: `role="button"` + `onActivate`; one `prefers-reduced-motion` block |
| UX-023 | Palette is unreachable by keyboard while the board, the code view or any dialog is open (overlay gate) | Low | High | fix: allow Ctrl+K through the gate; the palette can sit above a dialog |
| PERF-002 | Four independent pollers: usage chip (10 s) and usage tab (15 s) both call `rpc("usage")`; worktrees 8 s; board 4 s; group chat 2 s, all while visible | Low | High | fix: one usage subscription pushed by the backend; board/worktrees refresh on events |
| IDEA-008 | Inspiration credits: typesafe.ai (System One / Jev), laya, Hermes and Handy are named in the README history but not credited anywhere in the repo; T3 Code, herdr and Odysseus are | Low | High | add an "Inspiration" list to docs/COMPARISON.md |

### Transcript versus the inspirations

| Where | hive | T3 Code / herdr | Deliberate? |
|---|---|---|---|
| Tool calls during a turn | full-width bordered cards, one per tool, with the kind label repeated in the title | one compact line per tool, collapsed into "Worked for N" as soon as the turn ends | no (UX-016) |
| Your own messages | full-width tinted box indented 18 % from the left | small right-aligned bubble (T3) / plain line (herdr) | undocumented; keep, but document it |
| Turn footer | dashed rule + "done · 4,210 tok · 8:52 AM" on every turn | nothing per turn; tokens in a status bar | undocumented; the token count is useful, the dashed rule and timestamp are noise |
| Pane header | 11 items (UX-013) | name, state, one action | no |
| Focused pane | accent border + 1 px ring + 18 px glow (`:1245`), added by the contrast pass against the "no glows" rule at :403/:437/:606 | one accent edge | no; the comment and the rule disagree |
| needs-you pane | amber border replaces the accent, so a focused pane that needs you shows amber only | herdr: state in the header, focus on the edge | undocumented |
| Palette | matches: states, shortcuts, filter words, footer hints | | yes |
| Fold ("Worked for 1m 12s · 4 steps") | matches after the turn ends | | yes |

### Control inventory

Mapped: 24 palette actions (+ 5 code, + 9 voice), 18 global shortcuts, 15 top-bar controls, 6 sidebar sections, 11 pane-header controls, 7 composer controls, 7 drawer tabs with 20 body controls, 13 dialogs (full table in `audit/evidence/pass6/inventory.md`). Verdicts: **keep** 78 · **fix** 9 (BUG-008/009/010, UX-015/016/018/019/020/021) · **merge** 11 (UX-017) · **relabel** 3 (drawer tabs, Usage chip, Team toggle) · **remove** 2 (Ctrl+\, Ctrl+Shift+[ ]). Tested in the interface: everything `test/ui.ts` covers plus the scenario script; inspected in code only: device panes, verdict view, teacher dock, voice setup.

### Journeys

| Journey | Result |
|---|---|
| Returning operator (6 agents, mixed states) | sidebar, palette and headers agree on the state; the title shows "✓ 1 ready"; the needs-you pane is amber. Fine at 1680 px; headers clip at 1280 px (BUG-005) |
| One task end to end (mock) | permission card inline, Allow/Reject, result on disk: passes in `test/ui.ts` |
| Hand-off A → B over mail | B woken, mail shown in both panes with the sender: passes in `test/ui.ts` |
| Team broadcast | lead chosen, wait notices in the others, no turn spent: passes in `test/ui.ts` and `test/backend.ts`. The lead's prompt label "Team task · you lead · …" is clear; the others' notice is one grey mono line that is easy to miss |
| Improvements → coder → owner | briefing rule only; not exercised with a real model (mock can't follow it). **Unverified.** |
| Jobs (loop / interval / watch) | schedule, run history, stop: pass in `test/ui.ts` and `test/scheduler.ts`; the sidebar card wording is UX-020 |
| Review group, held mail | Release / Edit / Drop: passes |
| Dictation (fake Whisper) | text lands in the hovered pane, not sent: passes |
| Interrupt / backend restart | Esc cancels; backend crash auto-restarts and panes reconnect: passes. Ready marks and `starting` survive a restart (state trace §6); a turn killed mid-flight gets no done mark, by design |
| Automatic decisions | lead choice (rule), reflection (rule + model), held mail (rule), declined prompt after 15 min (rule), usage-limit pause (rule). All visible as a toast, a notice or an inbox item. None is reversible from the UI except held mail (Release). A small fast model (System One / Jev) would not improve any of these: they are rules with no judgement in them; the one judgement call, picking the lead, is a 5-line regex on roles, and a wrong pick costs one turn. **Recommendation: no.** laya-style token saving: the only automatic spend is reflection and ✦ improve, both already capped; nothing to save |

### Load and failure states

No agents, one, six: fine (r01, 03, r07). 25-turn transcript: renders without lag; no virtualisation, so hundreds of tool calls would need a check with a real vendor. Vendor not installed / not signed in: Accounts tab says so with the command to copy (BUG-017 aside). Backend restart: covered. 120 % zoom at 1680 px with six panes: transcripts become 150 px tall (r15); acceptable. Light theme: fine. Both 760 px and 1280 px: 760 is the phone layout (fine); 1280 is BUG-005.

### Design rules (proposed)

1. One `:root` token block; the old alias names are removed after a rename pass.
2. Type scale: 11 / 12 / 13 / 15 px. Chips 20 px, controls 28 px, composer icons 30 px, radii 4 / 6 / 8 / 999.
3. One `StatePill` component and one pulse keyframe for every surface.
4. Header = name · role · state · Stop · Maximize · "…". Everything else in the sub row.
5. In-flight tool calls look like folded ones: one line each.
6. Only the focused pane has an accent edge; needs-you is a header colour, not a border.
7. Every dialog has ✕; every clickable row has a role and a key handler.
8. Container queries, not media queries, decide what a pane hides; they live after every other pane rule.

### Order of work

1. BUG-005, BUG-006, BUG-007 (narrow widths) and BUG-008 (undo): one CSS commit, with the 3-column probe back in `test/ui.ts`.
2. UX-010 + UX-011 + UX-012 + BUG-015/016: collapse `styles.css` to one token block and one state system. This is the big one; do it before any screen-level polish.
3. BUG-011/012/013/014: one `agentState` everywhere, title via `rollup`.
4. UX-013 + UX-016: header diet and tool-line rendering.
5. UX-014/015/017/018/019/020/021: control cleanup.
6. BUG-009/010, UX-022/023, PERF-002, IDEA-008.

### Pass 6 fixes (2026-10-04)

All pass-6 items were fixed in one round and verified by `npm test` (30 suites) and `npm run test:ui` (new checks: 1280 px / 3 columns nothing clips, undo button width, Ctrl+J closes the board, every dialog has ✕, the pane … menu). Screenshots regenerated.

| ID | What changed |
|---|---|
| BUG-005/006/007 | container queries moved to the end of `styles.css` (nothing can undo them); the header now holds name · role · state · actions only, everything else in the sub row, which collapses by width; tables never break words and scroll sideways; drawer tabs sit on their own row and never wrap |
| BUG-008 | composer rules share one specificity; undo is text-wide; ✦ hover accent works |
| BUG-009 | palette "Zoom in" zooms in (hint names Ctrl+- / Ctrl+0) |
| BUG-010 | Ctrl+J closes the board; Ctrl+I / M / J / P ignore Shift; the board and the code view are "panel" overlays, so Ctrl+K opens the palette over them (UX-023) but never over a form dialog |
| BUG-011/012/013/014 | `agentState`: "needs you" only from open asks, tool-set waiting is shown as working with a note, asleep → stopped; window title uses `rollup`; other agents use the same `StatePill`; palette re-reads states while open |
| BUG-015/016 | leftover `.pane.ready` / `.pane.linked` borders removed; the colour-mix override removed and the dark themes' borders set per theme |
| BUG-017 | one loading line in Accounts |
| UX-010/011/012 | one `:root` token block (the two older ones and the alias names are gone; 14 legacy names rewritten); type scale `--fs-1..4`, chip/control/icon heights, `--r-pill`; one `hive-pulse` keyframe and one dot size for `.dot`, `.gdot`, `.st-dot` and the voice badge; one reduced-motion block |
| UX-013 | pane header diet; job, link and fresh session live in a … menu |
| UX-014 | Team/Each is a small select in the broadcast box ("as a team" / "to each"); the Verdict button left the top bar (palette, welcome screen and the prompt editor still open it) |
| UX-015 | placeholder is "message <name>…"; while working a line above the box says "Enter queues your message · Esc cancels the turn" |
| UX-016 | tool calls are one line each while running and after the fold; the verb is shown once |
| UX-017 | Ctrl+\ and Ctrl+Shift+[ ] removed; one "Restart" label; bell and palette share `togglePing` |
| UX-018/019 | ✕ in every dialog (`Modal`); the card editor uses `Modal`; "Delete group" moved to the group header, away from Send |
| UX-020/021 | job cards: schedule on one line, runs on the next; Add agent model field says "default" with a hint under it |
| UX-022 | group rows, mail rows and stats rows are keyboard-reachable buttons |
| PERF-002 | one usage poller (`usage.ts`) feeds the chip and the Usage tab |
| IDEA-008 | "Inspiration" section at the top of docs/COMPARISON.md |

Still open from this pass: none. Not re-verified with a real vendor (mock only).

### Pass 6 loop (2026-10-04, one small fix per tick)

| Tick | ID | What | Verified |
|---|---|---|---|
| 1 | UX-024 | Turn footer was a dashed rule + "done · 4,210 tok · 3:12:14 PM" on every turn (noise next to T3 Code). Now one quiet right-aligned "4,210 tok"; stop reason and time in the tooltip; cancelled/error turns in amber | UI test (cancel still shown) |
| 1 | UX-025 | The team-broadcast "waiting for the lead" notice was a grey mono line, easy to miss. Now a tinted accent line with a ◔ mark | UI test (`.notice.team`) |
| 2 | UX-026 | Sidebar rows ended in a truncated "Default (recommended)" for every agent on the vendor's default model; the default is left out, a chosen model is shown | UI test |
| 2 | UX-027 | The pane … menu items had no `menuitem` role | UI test |
| 3 | UX-028 | Group chat: "Direct / Review each message" had no explanation beyond tooltips; one line under the header now says what the current mode does and the hourly cap | UI test |
| 4 | UX-029 | Tool lines showed the ACP kind "other" as a verb ("other ToolSearch"); generic kinds are hidden | full `npm test` + UI test this tick |
| 5 | UX-030 | "Other agents in this hive" listed every finished skill run and sleeping agent for good (clutter after a week of use); sleeping ones now fold under "N finished" | UI test |
| 6 | BUG-018 | The empty-transcript hint never showed: the "session new" line made the list non-empty. It now keys off real conversation items and names ✦, / and Esc | UI test |
| 7 | UX-031 | Rows made keyboard-reachable in pass 6 (mail, groups, stats, cards, menu items) had no visible focus ring; tall form fields (Instruction) had their label floating mid-height | UI test (label alignment) |
| 8 | UX-032 | A nearly full context window (>85 %) was only a colour on the meter. The composer now says "Context is N% full: replies get worse and cost more" with a one-click Fresh session (mock: `ctx-full`) | UI test |
| 9 | UX-033 | Palette agent rows said "claude-code · hive/coder"; the role (what the agent is for) comes first now, kind and branch after | UI test |
| 10 | BUG-019 | A cancelled or errored turn's footer ended in a dangling "·" (tick 1 regression); sidebar section titles wrapped under their buttons ("Other agents in this hive" / "4 finished") | UI test |
| 11 | UX-034 | The sidebar's "N finished" button wrapped onto two lines beside its section title; one line now. Full `npm test` (30/30) re-run this tick | UI test |
| 12 | UX-035 | Phone layout: toasts stacked over the pane header (the agent's name and state); they now sit above the bottom bar | UI test |
| 13 | UX-036 | Code-view questions to the teacher showed the whole generated prompt (path, fenced code, instructions) as a user message in the dock and in the teacher's pane; they fold under a one-line label ("Explain · src/hello.ts lines 2–4") like other hive-written prompts | UI test |
| 14 | UX-037 | Spending-guard toasts read "paused = 1" / "daily_tokens = 2000000"; they now say what happened ("Automatic work paused: jobs and mail wake-ups wait; your own prompts still run", "daily_tokens set to …") | UI test |
| 15 | UX-038 | Screen-reader labels: the broadcast checkbox ("include alpha in broadcast"), the context meter ("context window 19% full", `role=img`), and the decorative pane number hidden | UI test |
| 16 | UX-039 | Add agent's permission options said "reject-all — read-only" (wrong: it is chat only, no tools) and "trusted"; they now use the pane's own words with one line each: asks first / reads freely / full access / chat only | UI test |
| 17 | UX-040 | Closing a pane while its agent was working cancelled the turn silently; it now asks first (the session is kept and can be reopened from "Other agents"). Full `npm test` 30/30 re-run | UI test |
| 18 | — | Verified BUG-011/013 end to end: with one permission ask open, the pane, the sidebar word and the window title ("(1) hive — needs you") agree | UI test |
| 19 | UX-041 | Verdict setup: the "Code / Text" toggle had no label; it is now "What they make" with one line explaining each choice | UI test |
| 20 | UX-042 | Recipes: "Main agent / Checkers / Prefix" were jargon; now "Does the work / Checks the work / Name prefix", a line on why a different vendor should check, and the prefix explained | UI test |
| 21 | UX-043 | Empty states in the Hive panel used tool names ("Agents write here with hive_send to "owner"", "Empty."); Inbox, Mail and Blackboard now say in plain words what will appear there and why | UI test |
| 3 | — | The improvements → coder → owner flow is now covered by `test/team.ts` at the wiring level (scout sends ideas to the coder; the coder asks the owner first). Model behaviour still unverified with a real vendor | test/team.ts |

## Pass 5 (2026-10-01)

Security review of permission prompts and agent-to-agent reach, plus a review of `hive tui`, the CLI and the phone-access setup scripts. Items not fixed yet are being fixed on the core and UI branches.

| ID | Title | Sev. | Conf. | Status | Verified by |
|---|---|---|---|---|---|
| SEC-005 | Permission prompt skipped for shell commands whose text names a hive tool (`rm -rf ~ && echo hive_status`), and for another MCP server's `mcp__evil__hive_send` | High | High | **fixed** in 4449f95: the whole title must be a hive tool, execute calls never match | test/fixes.ts |
| SEC-003b | Unlinked agents can still reach allow-all agents through broadcasts (`*`) and groups they create themselves | Medium | Medium | in progress (core/UI branches) | — |
| SEC-006 | Secrets (API keys, bridge tokens) passed on to agent processes in their environment | Medium | Medium | in progress (core/UI branches) | — |
| TUI-001 | `hive tui <unknown team>`, an unknown `--agent`, or a stale `tui.json` entry threw after raw mode + alternate screen: broken terminal, and the stale layout failed every time | High | High | **fixed**: team/agent checked before the screen switch; bad layout entries skipped with a hint and dropped; terminal restored on every exit path | test/tui.ts; pty run |
| TUI-002 | Multi-line paste: each line submitted separately, Tab moved focus | High | High | **fixed**: bracketed paste; a paste is one block in the prompt (newlines shown as ⏎, sent intact) | test/tui.ts |
| TUI-003 | Tabs, ANSI escapes and control characters in agent output shifted pane borders | Medium | High | **fixed**: output sanitized before wrapping (tabs to 4-column stops) | test/tui.ts |
| TUI-004 | Long input: cursor drawn on the wrong character; wide characters overflowed the line | Medium | High | **fixed**: horizontal window around the cursor in display columns | test/tui.ts |
| TUI-005 | Cursor moved in UTF-16 units; Backspace after an emoji left a lone surrogate | Low | High | **fixed**: editing by code points | test/tui.ts |
| TUI-006 | `/rm --forget [name]` failed (flag read as the name) | Low | High | **fixed** | test/tui.ts |
| TUI-007 | `/verdict --judge` with no value, `/release` without id, `/link` and `/group` names unchecked, Esc recorded `/stop` in history, PgUp unbounded | Low | High | **fixed** | test/tui.ts (most) |
| CLI-001 | Bad arguments (`--foo`, missing value, a prompt starting with `-`) printed a stack trace; no `--version` | Medium | High | **fixed**: one line plus a hint to use `--`; `hive --version` | manual |
| CLI-002 | Expected errors (not a git repository, unknown worktree or skill) printed stack traces | Medium | High | **fixed**: message only; `HIVE_DEBUG=1` for the stack | manual |
| CLI-003 | Stale help (recipes without squad, `hive job show`, worktree location); a wrong `--policy` reported as "could not start" | Low | High | **fixed**: help updated, `--policy` checked up front | manual |
| OPS-001 | `setup-remote.sh --ssh-only-tailscale` with ufw: an existing `allow OpenSSH`/`allow 22` rule came before the deny, so SSH stayed open on every interface | Medium | High | **fixed**: those allow rules removed, the tailscale0 allow inserted first; firewalld also drops port 22 and the public zone's ssh | dry run, code reading |
| OPS-002 | `setup-remote-windows.ps1`: Administrators looked up by name (localised on non-English Windows), so the wrong authorized_keys file was named | Medium | High | **fixed**: by SID S-1-5-32-544 | code reading |
| OPS-003 | `setup-remote-windows.ps1`: DefaultShell could be the WindowsApps `pwsh` alias, which sshd can't start (SSH sessions close at once) | Medium | Medium | **fixed**: `%ProgramFiles%\PowerShell\7\pwsh.exe` if present, else Windows PowerShell | code reading |
| OPS-004 | `setup-remote.sh`: `dnf install curl` conflicts with curl-minimal; relative `--project` broke the systemd unit; `--project` without a value crashed | Medium | High | **fixed** | dry run |
| OPS-005 | `.ps1` files are UTF-8 without BOM: Windows PowerShell 5.1 showed mojibake for → and · | Low | High | **fixed**: ASCII only | grep |
| DOC-001 | docs/COMPARISON.md and the pass-1 table below still listed SEC-001/002/003 as open | Low | High | **fixed** | — |

## Pass 1 register (as found, 2026-09-30)

The original pass-1 table, kept for history. "Status now" is the current state; details are in the Summary above.

| ID | Title | Sev. | Conf. | Classification (pass 1) | Status now |
|---|---|---|---|---|---|
| SEC-001 | A repo's `.hive-skills/*.md` can request `policy: allow-all` | Medium | High | confirmed defect | fixed (passes 2–3) |
| SEC-002 | Symlinks let API-agent file tools and media inputs leave the folder | Medium | High | confirmed defect | fixed (passes 2–3) |
| COST-001 | No default token cap for pay-per-token API agents; agent chatter can burn tokens for hours | Medium | Medium | supported concern | fixed (passes 2–3) |
| SEC-003 | Confused deputy: any agent can drive an `allow-all` agent through mail / `hive_followup` | Medium | Medium | supported concern (by design) | fixed (pass 4); follow-up SEC-003b in pass 5 |
| BUG-001 | Skill `output:` check is fooled by a sibling folder sharing a prefix | Low | High | confirmed defect | fixed (passes 2–3) |
| BUG-002 | Failed media calls (no key, API error) still count against `media_daily` and show as usage | Low | High | confirmed defect | fixed (passes 2–3) |
| UX-001 | Add Agent accepts "owner": a dead pane whose Retry can never work | Low | High | confirmed defect | fixed (pass 2) |
| UX-002 | Name validation message is the same for every error (length, spaces, unicode) | Low | High | confirmed | fixed (passes 2–3) |
| UX-003 | `hive providers add` accepts a non-URL base; `hive doctor` shows ✓ for an unreachable API | Low | High | confirmed | fixed (passes 2–3) |
| IDEA-001 | Trusted senders / per-agent mail allowlist | Opportunity | — | opportunity | done as links |
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
When 3+ agents run jobs, only some matter. Add a mute toggle on the pane header. With an always-on server, the bridge could push "coder is ready" for human-started turns, like job endings are pushed now. S.

### IDEA-004: Prompt-engineer round trip
Today ✦ Improve runs the skill in its own pane and saves to `out/prompts/`. Add a "Use this prompt" action on that pane's last reply that fills the editor of the pane you came from. S–M.

---

## New in passes 2–3 (details)

### BUG-003: Held mail stranded when its group is deleted (pass 2)
- **Reproduction (before)**: link two agents in review mode; one messages the other (held); open the group chat → Delete group → confirm. The chip and group disappear. The message is still held in the database (`hive held` lists it) but no UI shows it, and nothing delivers it (evidence/probe2-output.txt).
- **Fix**: `deleteGroup` refuses while mail routed through the group is waiting. The UI shows "@g has N messages waiting for your review; release or drop them first". **Verified**: test/fixes.ts; UI probe after fix shows the toast and the chips remain.

### UX-004: Pane header at 3–4 columns (pass 2)
- **Before**: at ~400 px wide panes, the group chip wrapped into two lines over the model select ("Mock Sm"), and the long-named pane's header overflowed by 63 px, cutting off the close button (evidence/probe2-output.txt, p2-layout-1920-3cols.png at pass 2).
- **Fix**: each pane is a CSS container. The name ellipsizes; chips don't wrap and truncate their name, not their held-count badge. The kind badge and index hide below 560 px, the context meter below 430 px, the model select below 360 px (the model also shows in the sidebar). **Verified**: same probe after the fix; all actions visible and aligned.

### A11Y-001 / A11Y-002 (pass 3)
- Tab ×25 in the Add Agent dialog left the dialog 20 times (focus reached the top bar and panes behind). After the fix: 0. Focus returns to where it was when the dialog closes.
- The toast region had no live region; it now does, so "agent ready" and errors are announced.

### SEC-004: allow-all agents can change hive itself (pass 3, open)
- An agent allowed to run any command runs as your user, so it can write `hive.db` (e.g. insert mail "from owner", set `budget.paused=0`) and `agents.json`. hive can't prevent this without a sandbox.
- Recommendation: keep `allow-all` for agents in their own worktree on trusted tasks; prefer Codex (sandboxed writes) for allow-all automation; use review-mode groups for agents that read untrusted input.

### PERF-001 (pass 3)
- Bench (evidence/perf-bench.txt): 20k messages, 30 agents, 20 groups. `route` 0.08 ms, group chat query 0.7 ms, the per-second groups push 1.05 ms, `unreadCount` 2.4 ms per agent. That's about 70 ms/s of backend work at 30 agents with 20k messages. Pruning (PRIV-001) keeps the table small; a partial index for unread mail is the next step if needed.
