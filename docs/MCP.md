# Extra MCP servers (DaVinci Resolve and others)

Every hive agent gets hive's own MCP server (mail, blackboard, board, media).
You can give agents **more** MCP servers: a video editor, a database, a design
tool. hive passes them to the agent when its session opens, next to `hive`.

Two places to configure them, both in your hive home folder
(`hive mcp` prints the path; Windows: `%LOCALAPPDATA%\hive`, Linux:
`~/.local/state/hive`, or `$HIVE_HOME`):

| file | what it holds | applies to |
|---|---|---|
| `mcp.json` | named servers you can attach to any agent | agents you start with `--mcp NAME` or tick in the Add-agent dialog |
| `agents.json` → `"mcp"` | servers (inline, or names from `mcp.json`) for an agent **type** | every agent of that type |

## 1. Define a server: `mcp.json`

```json
{
  "davinci": {
    "command": "uv",
    "args": ["--directory", "C:/mcp/davinci-resolve-mcp", "run", "resolve_mcp_server.py"]
  },
  "pg": {
    "command": "npx",
    "args": ["-y", "some-postgres-mcp-server"],
    "env": { "DATABASE_URL": "${PG_URL}" }
  }
}
```

- `command` + `args` start the server (stdio). `${VAR}` is filled from hive's environment.
- `env` is the **only** environment hive hands the server. Write `"${PG_URL}"`
  to pass one variable through; nothing else of hive's environment is added.
  Keys never go in this file, only the names of the variables that hold them.
- Names: letters, digits, `_ . -`; `hive` is taken.

## 2. Attach it

- **One agent, CLI:** `hive chat claude --mcp davinci` (several: `--mcp davinci,pg` or `--mcp a --mcp b`).
  Works for `run`, `chat`, `loop`, `every`, `watch`, `once` and `start`.
- **One agent, app:** the Add-agent dialog lists the servers from `mcp.json` as
  checkboxes. Hover a pane's folder line to see which servers it has.
- **Every agent of a type:** in `agents.json`:

```json
{
  "editor": { "type": "acp", "label": "Video editor", "command": "claude-agent-acp", "args": [], "mcp": ["davinci"] },
  "claude": { "mcp": [{ "name": "pg", "command": "npx", "args": ["-y", "some-postgres-mcp-server"] }] }
}
```

An entry with only `"mcp"` and the id of a built-in type (`claude`, `codex`, …)
adds servers to that type.

hive remembers an agent's servers, so a restart or an overnight mail wake-up
gets the same ones. A misspelled name stops the start with an error rather than
starting the agent without its tools. `hive mcp` lists what is configured.

## What the server can see

hive gives each server only the `env` its entry names. The agent CLI that
launches the server (Claude Code, Codex…) may pass its own environment along
too; hive already strips bridge tokens, media keys, the Twitch secret and other
providers' API keys from every agent's environment, so those don't reach a
server either.

Servers run with the agent's permission policy: their tools show up as
`mcp__<server>__<tool>` and an `ask` / `allow-reads` agent asks you before it
uses them.

## DaVinci Resolve

The community **DaVinci Resolve MCP server** (search GitHub for
"davinci-resolve-mcp") drives Resolve through its scripting API: list and
create timelines, import media, add markers, render. Follow its README to
install it (Python, usually with `uv`).

Important: **it talks to the Resolve running on the same machine.** Resolve's
scripting API is local only. So:

- The agent that uses it must run in a hive **on the Windows desktop where
  Resolve runs**: start the app there normally (`hive ui`), not
  `hive ui --remote you@server` (remote agents run on the server and can't see
  your Resolve).
- Resolve must be open, with **Preferences → System → General → External
  scripting using: Local**. Resolve Studio is needed for external scripting in
  many versions; check the server's README.
- On Windows the server needs Resolve's scripting paths. Pass them through
  `env` if your setup needs them:

```json
{
  "davinci": {
    "command": "uv",
    "args": ["--directory", "C:/mcp/davinci-resolve-mcp", "run", "resolve_mcp_server.py"],
    "env": {
      "RESOLVE_SCRIPT_API": "C:/ProgramData/Blackmagic Design/DaVinci Resolve/Support/Developer/Scripting",
      "RESOLVE_SCRIPT_LIB": "C:/Program Files/Blackmagic Design/DaVinci Resolve/fusionscript.dll",
      "PYTHONPATH": "C:/ProgramData/Blackmagic Design/DaVinci Resolve/Support/Developer/Scripting/Modules"
    }
  }
}
```

Then: `hive chat claude --name editor --mcp davinci` and ask "make a timeline
from the clips in D:/footage/today and add a marker at every scene change".
The motion graphics hive renders (`hive render --alpha`, see
[CREATOR.md](CREATOR.md)) come out as ProRes 4444 `.mov` files with
transparency that the editor agent can import.

## Servers the agent CLI loads by itself

Claude Code and Codex can also load MCP servers from their own config
(Claude Code: `claude mcp add …`, `~/.claude.json`, a project `.mcp.json`;
Codex: `[mcp_servers]` in `~/.codex/config.toml`). Whether an agent started
through hive picks those up depends on the CLI and its version. Those servers
apply to every session of that CLI, hive or not. Use hive's `mcp.json` when you
want a server only on some agents, in the app's checkboxes, or with an
explicit, minimal environment.

API agents (gemini-api, openrouter, ollama…) run inside hive and only ever get
the servers hive gives them.
