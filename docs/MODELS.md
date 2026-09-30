# Models: subscriptions (CLIs) and API keys

hive runs two kinds of agents side by side. Both get the same panes, mail, groups, jobs, skills, budgets and permission policies.

| kind | what | billed | tools |
|---|---|---|---|
| CLI | `claude`, `codex`, `gemini`, `qwen`, `opencode` via their ACP adapters | your subscription (Claude Max/Pro, ChatGPT) or the CLI's own config | the vendor's full toolset (shell, edits, …) |
| API | built-in agent for any OpenAI-compatible API: `gemini-api`, `openrouter`, `openai-api`, `ollama`, plus your own | per token to your key (Ollama: free, local) | hive tools + read/list/write files in its folder. **No shell.** |

`hive providers` lists them and shows which keys are set.

## Built-in API providers

```powershell
# Google Gemini (free tier available): https://aistudio.google.com/apikey
setx GEMINI_API_KEY "..."          # optional: setx GEMINI_MODEL "gemini-2.5-pro"
# Meta Llama and hundreds more with one key: https://openrouter.ai/keys
setx OPENROUTER_API_KEY "..."      # optional: setx OPENROUTER_MODEL "meta-llama/llama-4-maverick"
# OpenAI API (separate from a ChatGPT subscription — use codex for that)
setx OPENAI_API_KEY "..."
# Ollama on this PC or the T550 (no key)
setx OLLAMA_BASE_URL "http://192.168.10.69:11434/v1"
setx OLLAMA_MODEL "qwen3"
```

Open a new terminal, then `hive doctor gemini-api` ("API key (GEMINI_API_KEY)" = ready) and `hive chat gemini-api`, or pick "Google Gemini · API" in the UI's **+ Agent** dialog. The pane's model picker lists every model the endpoint offers.

## Add any other OpenAI-compatible API

```powershell
hive providers add groq --base https://api.groq.com/openai/v1 --key-env GROQ_API_KEY --model llama-3.3-70b-versatile --label "Groq"
hive providers add mistral --base https://api.mistral.ai/v1 --key-env MISTRAL_API_KEY --model mistral-large-latest
hive providers add lmstudio --base http://localhost:1234/v1 --model local-model
hive providers rm groq
```

These go to `<hive state dir>\agents.json` (`%LOCALAPPDATA%\hive\agents.json`). Only the **name** of the env var is stored, never the key. You can also add another ACP agent there by hand:

```json
{ "my-agent": { "type": "acp", "label": "Some ACP agent", "command": "some-agent", "args": ["--acp"] } }
```

Options for API entries: `base`, `keyEnv`, `model`, `models` (fixed list for the picker), `context` (tokens, default 128000), `tools: false` (for models without function calling).

## What API agents can and can't do

- Every tool call goes through the agent's permission policy: `allow-reads` lets it read/list but asks (or refuses) before writing; `reject-all` makes it chat-only; `allow-all` lets it write files in its folder.
- It can't leave its folder (paths outside are refused) and can't run commands. For coding with a shell on an API model, use `opencode` or `qwen` with that API instead.
- Token usage is recorded per provider (`hive usage`) and counts toward budgets. At most 25 tool rounds per prompt (`HIVE_API_MAX_STEPS`).
- Conversations are saved under `<hive state dir>\api-sessions\` so panes resume after a restart.
