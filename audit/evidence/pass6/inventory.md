# Pass 6 control inventory (2026-10-04)

Source: code trace of `src/ui/renderer/` at commit 6a0851e. Verdict legend: K keep · F fix · M merge · R relabel · X remove.

## Palette actions (App.tsx:199-233, Code.tsx:163, Voice.tsx:899)
| id | label | keys | does | verdict |
|---|---|---|---|---|
| new | New agent | Ctrl+N | AddAgentDialog | K |
| team | Set up a team (recipes) | | RecipesDialog | K |
| verdict | Verdict | | openVerdict | K (drop the top-bar button, UX-014) |
| skills | Run a skill | Ctrl+Shift+K | SkillsDialog | K |
| link | Link agents so they can talk | | LinkDialog | M (UX-017) |
| inbox | Inbox and messages waiting for review | Ctrl+I | drawer (open only) | K |
| usage | Usage, limits and spending guards | | drawer usage | K |
| git-init | Make this folder a git project | | rpc gitInit | K |
| learn | Memory and learning | | drawer learn | K |
| stats | Token stats | | StatsDialog | K |
| broadcast | Message all agents | Ctrl+Shift+B | focus broadcast box | K |
| sidebar | Toggle sidebar | Ctrl+B | | K |
| max | Maximize / restore | Ctrl+M | | K |
| layout | Layout: next (now cur) | | cycles orientation | K |
| board | Board | Ctrl+J | open only (BUG-010) | F |
| browser / android | Open browser / Android device | | device panes | K |
| theme-* ×7, density-* ×2 | | | saveLayout | K |
| hover | Hover to focus panes | | | K |
| ping | Finish chime | | | M with the bell (UX-017) |
| zoomin | Zoom in / out / reset | | **no-op** (BUG-009) | F |
| code-open / code-browse / code-changes | Open file / Browse code / Code changes | Ctrl+P | code view | K |
| teacher-start, explain-toggle | | | | K |
| talk-/voice-/speak- per agent, voice-setup, voice-send, voice-ptt, voice-hands, voice-auto, voice-stop | | | | K |

## Global shortcuts (App.tsx:120-188)
Ctrl+1..9 K · Ctrl+Tab K · Ctrl+Shift+[ ] X (duplicate) · Ctrl+N K · Ctrl+Shift+B K · Ctrl+B K · Ctrl+\ X (duplicate) · Ctrl+= - 0 K · Ctrl+Shift+K K · Ctrl+K K (let through every overlay, UX-023) · Ctrl+J F (BUG-010) · Ctrl+I F (Shift check) · Ctrl+P K · Ctrl+M F (Shift check) · Esc (overlay) K · PTT Ctrl+Shift+Space K · global Ctrl+Alt+H K.

## Top bar (App.tsx:418-498)
☰ K · broadcast input K · mic K · Team/Each R (UX-014) · Send K · Group N K · ✕ N clear K · ✓ N ready K · bell K · − cols + K · Usage chip R · Verdict X (in palette) · Commands K · Board X (in palette, Ctrl+J) · Hive K · + Agent K.

## Pane header (Pane.tsx:64-118)
checkbox K · index K · name (drag) K · kind → sub row (UX-013) · role badge K · group chip → sub row · context meter → sub row · state pill K · queued/jobs badges → sub row · speaker (voice) → "…" · Stop K · Clock (job) → "…" · Link → "…" · Fresh session → "…" (+ aria-label) · Maximize K · ✕ K.

## Composer (Pane.tsx:756-780)
config selects K · undo F (BUG-008) · ✦ K · mic K · expand K · send K · "/" menu K.

## Sidebar
Search K · + K · agent items K · groups (link icon M, scope toggle K, guard checkbox K, group li F a11y) · other agents "open" K · worktrees refresh/merge K · jobs items K, stop K.

## Drawer (Drawer.tsx)
Tabs R (BUG-007) · refresh K · dock toggle K · ✕ K · report window K · accounts check again K, copy command K · usage pause/budget rows K · mail rows F a11y · blackboard filters/delete K · compose K · learning controls K · held list actions K.

## Dialogs
Add agent K (Model placeholder F, UX-021) · Job K (sidebar wording F, UX-020) · Link K · Group chat F (no close; Delete placement, UX-018/019) · Recipes K · Skills K · Prompt editor K · Stats F (no close) · Verdict setup K · Verdict view F (no close) · Board K · Card editor F (own modal, no trap) · Job runs K · Start teacher K · Voice menu / setup K.
