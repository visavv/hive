# Contributing

Thanks for helping. hive is small enough to read in an afternoon. Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Set up

```bash
git clone <repo-url> hive && cd hive
npm install
npm test            # all suites with a mock agent: no logins, no network, ~3 min
npm run build
```

`npm run test:ui` drives the real desktop app. On Linux without a display, run `xvfb-run -a npm run test:ui`.

## Making a change

- **Keep it small.** One fix or feature per pull request, with a test in the matching `test/<area>.ts`.
- **Match the code around you.** Every file opens with a comment saying what it is for; keep that true. Plain names, short functions, comments that say *why*.
- **No real services in tests.** Use the mock agent (`src/mock/agent.ts`) and the fake servers the tests already have. Never send real messages (Discord, WhatsApp, email) from a test.
- **No secrets, ever.** Keys and tokens come from environment variables. Don't commit `.env` files, personal paths, hostnames or IP addresses; use `localhost`, `C:\code\myproject` or `~/code/app` in examples.
- **Before you push:** `npm run typecheck && npm test`. For UI changes, also run `npm run test:ui`.

## Adding a new agent vendor

Add one entry to `src/core/agents.ts`: how to launch its ACP adapter, how to log in, and which environment variables it needs. Then `hive doctor <id>` tells you whether it works.

## Reporting bugs

Open an issue with what you did, what you expected and what happened. `hive doctor` output helps; remove account names from it first.
