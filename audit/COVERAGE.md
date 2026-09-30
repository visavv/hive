# Coverage matrix

Role: single local user ("owner"); agents act as semi-trusted automated users. "Code" = inspected in source; "UI/CLI" = exercised hands-on; "Test" = exercised through the automated suites run during the pass (`npm test`, `npm run test:ui` under xvfb, `test/audit-probe.ts`).

| Area / workflow | State / input | How | Result | Pass | Gaps |
|---|---|---|---|---|---|
| First run (empty project, welcome screen) | no agents | UI | welcome + 3 entry points shown | 1 | — |
| Add agent dialog | valid, empty, spaces, unicode, 41 chars, "owner", duplicate | UI | validation works except "owner" (UX-001); one message for all errors (UX-002) | 1 | keyboard-only walk-through of the dialog |
| Many agents, horizontal | 10 panes, 2 columns | UI (screenshot p2) | grid scrolls; sidebar lists all; Ctrl+1..9 | 1 | 20+ panes perf |
| Vertical layout (9:16) | forced vertical; auto at 720×1280; 9 panes | UI + test | one column, 360 px panes, scrolls; Ctrl+N scrolls into view | 1 | real 1440×2560 monitor at 150% scaling on Windows |
| Ready mark + chime | turn ends while another pane is focused | Test | green pane, badge, title count, jump button, clears on focus | 1 | chime audibility; OS notification on Windows (not observable in CI) |
| Long prompt editor | 60k chars; save as skill with {{param}}; send; ✦ Improve | UI + test | renders in ~40 ms; skill file correct; draft kept | 1 | IME / undo behavior |
| Broadcast | whitespace-only | UI | Send disabled | 1 | — |
| Usage tab / chip | limit window, pause/resume, budget edit | Test | correct values, reset countdown; pause toggles | 1 | real Claude `_claude/rateLimit` payloads (mock only) |
| Budgets | daily, per provider, reserve, concurrency, pause, media | Test + CLI | enforced for automatic work only; validation of values | 1 | COST-001 defaults |
| Mail / groups / follow-ups | group backlog, read state, follow-up caps | Test + code | work; SEC-003 concern | 1 | adversarial prompt-injection run with real models |
| Scheduler triggers | loop/interval/watch/branches/bb/cooldown | Test | pass on Linux + Windows CI | 1 | long-running soak (hours) |
| API agents | stream, tools, policies, cancel, resume, errors, agents.json | Test + CLI + code | work; SEC-002 symlink; UX-003 | 1 | real Gemini/OpenRouter/Ollama endpoints (no keys in this environment) |
| Media tools | tts, voices, image, edit, cap, key isolation, bad key | Test + CLI + code | work; BUG-002; SEC-002 (edit inputs) | 1 | real ElevenLabs / images API |
| Skills | parse, render, output path, project override, prompt-engineer | code + probe + test | SEC-001, BUG-001 | 1 | — |
| Bridges (Discord/WhatsApp) | routing, allowlist, approve, rate limit | Test (fakes) + code | wiring OK | 1 | real accounts (not allowed: no real messages) |
| Worktrees / merge | coder preset, merge button | Test | pass | 1 | conflicts during merge in UI |
| Restart / resume | backend crash, app restart, renderer reload | Test | panes, history, sessions restored | 1 | power loss mid-write (SQLite WAL assumed) |
| Accessibility | focus style, accessible names, contrast of dim text | UI probe | focus outline present; all buttons have a text, aria-label or title; dim text 5.45:1 on pane bg | 1 | screen reader run (NVDA) on Windows; reduced motion honored only for the ready pulse |
| Security: rendering untrusted markdown | image/file URLs | Test | not loaded | 1 | — |
| Security: keys | agents.json, media keys, env | Test + code | env var names only; media keys stripped from agent env | 1 | OPENAI_API_KEY intentionally inherited |
| Windows | full suite + UI test on windows-latest | CI runs 3–9 green | 1 | run 10 (UI commit) queued at time of writing |
