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
