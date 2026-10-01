# Pass log

## Pass 1: 2026-09-30, commit e5d0908

**Scope decided.** hive is a personal, local, single-user tool: a multi-agent coding harness with an Electron UI, CLI and optional chat bridges. It targets Windows first, with Linux for a home server. It has no multi-user auth, so authorization means agent permission policies and trust between agents. The categories that matter most are tool permissions, path handling, spending, core UI workflows and Windows behavior. Monetization, enterprise administration and multi-tenant isolation are not applicable. Competitive analysis was done earlier in the session (herdr, T3 Code) and is not repeated here.

**Environment.** Linux container, Node 22.22, Electron under xvfb, mock ACP agent and fake HTTP APIs on 127.0.0.1. No real vendor logins or API keys; no real Discord/WhatsApp accounts, per the rules against real messages. Windows was covered only through GitHub Actions `windows-latest` (runs 3–9 green).

**What was run.**
1. `npm test` (11 suites) and `npm run test:ui`: all passed on this commit.
2. `test/audit-probe.ts` (hands-on UI probe, Playwright + Electron). Probes P1–P8 cover names, 10 agents, vertical, Ctrl+9, whitespace broadcast, a 60k prompt, focus styles and accessible names, and contrast. Output is in evidence/probe-output.txt, screenshots in evidence/.
3. CLI probes (evidence/cli-probes.txt): budget validation, providers add, doctor, send to an unknown agent, tts without a key, image without a prompt, usage.
4. Scratch probes against library functions:
   - `parseSkill` with `policy: allow-all` from a project → accepted (SEC-001).
   - `outputPath` with `../work2/…` → `/tmp/work2/pwned.md` allowed; `../../etc` refused (BUG-001).
   - `insideFolder` through a symlink to an outside folder → accepted (SEC-002).
5. Code reading: `hive_followup` and `hive_send` trust flow (SEC-003), budget defaults and wake budget (COST-001), `runMedia` order (BUG-002).

**Assumptions challenged.**
- "Budgets prevent runaway spend." They do only once configured, or where the provider reports a window (COST-001).
- "Folder confinement holds." It doesn't with symlinks (SEC-002).
- "Ctrl+9 is broken in vertical." Disproved; the cause was UX-001.

**Changes during the pass.** None to product code. Added: `audit/*`, `test/audit-probe.ts` (not in `npm test`), and `.hive-audit*/` in .gitignore.

**Next pass should investigate.**
- A real Windows desktop session: vertical monitor at 150% scaling, notifications, chime, `hive ui` from PowerShell.
- A prompt-injection exercise with real models (a reviewer trying to get a tester to run a command).
- Real API endpoints (Gemini free tier, Ollama on the T550).
- A soak test with jobs running for hours, checking memory.
- Keyboard-only and screen-reader walk-throughs.
- Merge conflicts from the UI.

## Pass 2: 2026-10-01 (first long prompt: edge cases, recovery, persistence, state combinations, layout)

**Changes before this pass (version boundary).** The audit-1 findings were fixed and untrusted-content labelling and YouTube links were added (commits e6be82d, a4f18dc). Every observation below is on the fixed code unless marked "before".

**Questions chosen.**
1. Do the pass-1 fixes hold in the real UI, not just in unit tests?
2. What happens between states in the new linking layer (held mail when a group is deleted, a member removed, the app restarted)?
3. How do pane headers and the top bar look at real monitor sizes and column counts?
4. Which background work is left dangling after a crash?

**What was run.**
- `test/audit-probe2.ts` (Electron + Playwright, hands-on):
  - invalid names in the dialog, and linking via the 🔗 button (keyboard path);
  - layout measured at 1920×1080, 1366×768, 1280×720, 1440×1280 and 720×1280, and at 3–4 columns: overflow, clipped children, top bar height;
  - Tab cycling in a dialog; the toast live region;
  - deleting a group with a held message; Esc in the prompt editor.
  - Output: evidence/probe2-output.txt (before) and probe2-after-fixes.txt (after); screenshots p2-layout-*.png.
- CLI: `hive held` and `hive groups` against the probe's database after the group delete (stranded message confirmed).
- Code reading: media job lifecycle, prune coverage, desktop entry quoting.

**Found.** BUG-003, BUG-004, UX-004, UX-005, UX-006, PRIV-001, UX-007, UX-008. All fixed and verified except UX-008 (cosmetic).

**Confirmed fixed.** UX-001 and UX-002 in the dialog ("owner" is reserved for you; not "ä"); no dead pane is created.

**Not tested.** A real Windows desktop with scaling; real vendor logins; real YouTube (the network isn't reachable here, so a fake server stands in).

## Pass 3: 2026-10-01 (second long prompt: accessibility, security, privacy, performance, competitive analysis)

**Questions chosen.**
1. Can a keyboard-only user complete the main flows?
2. Is there anything an agent can still do to hive itself?
3. How does the backend scale with message volume?
4. Are there really no comparable apps?

**What was run.**
- Accessibility (UI probe):
  - focus trap: 20 of 25 Tabs escaped the dialog before the fix, 0 after;
  - live region for toasts;
  - accessible names: pass 1 found every button had a text, aria-label or title; the new 🔗/🔔/layout buttons carry aria-labels;
  - contrast: dim text 5.45:1, unchanged from pass 1.
- Security: trust wrapper tests (content can't close the wrapper; owner vs peer), symlink confinement tests, review of what `allow-all` implies (SEC-004), desktop-entry quoting.
- Performance: `audit/evidence/perf-bench.txt` (20k messages).
- Competitive analysis: web research on 16 tools from official sources, dated 2026-10-01 (docs/COMPARISON.md). There are close competitors (Maestro, Agent Deck, Superset, Zed + ACP, Claude Code agent teams). hive's distinct points are cross-vendor mail/groups/blackboard, drag-to-link with per-message review, and no network listener.

**Found.** A11Y-001, A11Y-002 (fixed), SEC-004 (open, documented), PERF-001 (mitigated), plus IDEA-005 to IDEA-007 from the competitive research.

**Assumptions challenged.**
- "Wrapping peer content makes peer mail safe." It doesn't: it lowers the odds of injection, while the hard limits remain policies, review mode and the only-linked scope.
- "No listener means no attack surface." Local agents with shell access are the real surface (SEC-004).

**Next pass should look at.**
- Real Windows desktop: 150% scaling, vertical monitor, notifications.
- Real-model prompt-injection exercise against the trust wrapper.
- A screen reader run (NVDA, Orca).
- A long soak with jobs and links.
- IDEA-005 (chaining) and IDEA-006 (`.worktreeinclude`) as the most useful next features.
