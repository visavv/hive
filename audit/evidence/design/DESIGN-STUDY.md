# Design study: T3 Code, herdr, Odysseus, and what hive should take from each

Date: 2026-10-01. Method: shallow clones of `pingdotgg/t3code` (HEAD of default branch), `ogulcancelik/herdr` (redirects to `herdrdev/herdr`), and the existing Odysseus clone (`odysseus-dev/odysseus` @ `e303582`, `dev` branch). I read the styling sources directly and took Playwright/Chromium screenshots at 1440x900. All hex values come from source unless marked **≈** (converted from OKLCH or Tailwind names by hand) or **unverified**.

Scratch clones: `/tmp/claude-0/-home-user-hargent/da434d54-30be-57ef-b11a-02cf7debcf58/scratchpad/design/{t3code,herdr}` and `.../scratchpad/ody`.

---

## 1. T3 Code (desktop/web app for coding agents)

Sources: `apps/web/src/index.css` (2,237 lines, Tailwind v4 `@theme`), `apps/web/index.html` (boot splash and theme palettes), `apps/web/components.json`, `apps/web/src/components/ui/button.tsx`, `components/Sidebar.logic.ts`, `packages/shared/src/keybindings.ts`, `packages/contracts/src/settings.ts`, `apps/marketing/src/layouts/Layout.astro`, and `apps/marketing/src/styles/fonts.css`.

### Fonts
- **App UI:** system stack. `--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`. No bundled UI font. You can override it in Settings → Appearance (`appearanceFonts.ts`).
- **App code/terminal:** `"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`. CSS also puts `ui-monospace` first, but the TS stack drops it on purpose: some engines map `ui-monospace` to the proportional font.
- **Default sizes:** interface 16px (range 12–20), prompt/composer 14px, code 13px (range 10–18), terminal separate.
- **Dense type scale:** adds `text-2xs` 11px, `text-3xs` 10px, `4xs` 8px and `5xs` 7px for badges, counters and kbd hints. Buttons are `text-base` and drop to `sm:text-sm` (14px). Small buttons are `text-xs` (12px).
- **Marketing site:** "DM Sans" (weights 400/500, self-hosted woff2, OFL) and "JetBrains Mono" (OFL), with `font-feature-settings: "ss01","ss02"` and antialiased smoothing. The live t3.codes body computes to DM Sans 16px on `#09090b`.

### Color tokens (default theme, dark)
| Role | Token | Value |
|---|---|---|
| App canvas | `--background` | neutral-950 = `#0a0a0a` |
| Card / sidebar / popover | `--card` = 97% bg + 3% white | ≈ `#111111` |
| Muted / secondary fill | `--muted`, `--secondary` | white @ 3% |
| Hover / accent fill | `--accent` | white @ 4% |
| Border | `--border` | white @ 6% (≈ `#191919` on canvas) |
| Input border | `--input` | white @ 8% |
| Text | `--foreground` | neutral-100 = `#f5f5f5` |
| Muted text | `--muted-foreground` | 90% neutral-500 + 10% white ≈ `#818181` |
| Primary (buttons, focus ring) | `--primary` | `oklch(0.571 0.21 264)` ≈ `#4a6cf7` (blue-indigo) |
| Splash accent | — | `#818cf8` (indigo-400) |
| Success | emerald-500 / fg emerald-400 | ≈ `#10b981` / `#34d399` |
| Warning | amber-500 / fg amber-400 | ≈ `#f59e0b` / `#fbbf24` |
| Error | 90% red-500 + white / fg red-400 | ≈ `#f15757` / `#f87171` |
| Info | blue-500 / blue-400 | ≈ `#3b82f6` / `#60a5fa` |
| Tool-error icon | — | `#fca5a5` |
| Terminal cursor / selection | — | `rgb(180 203 255)` / same at 25% |

Light theme: canvas zinc-25 `oklch(99.2% 0 0)` ≈ `#fcfcfc`, card `#ffffff`, sidebar zinc-50 `#fafafa`, border zinc-200 `#e4e4e7`, input zinc-300 `#d4d4d8`, text zinc-800 `#27272a`, muted text zinc-500 `#71717a`, primary `oklch(0.488 0.217 264)` ≈ `#3550d6`.

There is also a "pure black" alternate: bg `#000`, fg `#f1f3f7`, accent `#191a1d`, muted `#0a0a0a`, muted-fg `#a3a3a3`, border white 8%. It also ships five tinted named themes (t3-chat pink, grove, ocean, ember, iris), each defined by only 4 OKLCH roles (background, foreground, accent, chrome).

**Design principle, stated in a code comment:** "Keep controls and floating surfaces close to the neutral-black canvas. Borders and hover states provide separation without milky gray fills." Every dark surface is the canvas plus 3–4% white, never a separate grey.

### Radii, spacing, shadows, motion
- `--radius: 0.625rem` (10px). sm = 6px, md = 8px, lg = 10px, xl = 14px. `--control-radius: 0.5rem` (8px) for buttons, sidebar rows, palette rows and tooltips.
- Control heights: default button h-8 (32px desktop), sm h-7 (28px), xs h-6 (24px), icon buttons 28–32px, and a 20px "tiny" button at 11px. Icons are 16px in buttons and 14px in small ones.
- Semantic insets: `--sidebar-content-inset .5rem`, `--sidebar-row-content-inset .625rem`, `--command-content-inset 1rem`, `--workspace-gutter .75rem` (1.25rem ≥ sm), `--workspace-topbar-height 52px`.
- Shadows are minimal. The composer uses `0 12px 28px -18px rgb(0 0 0/40%)` (dark: `0 14px 32px -18px /75%`). Buttons get a 1px inset top highlight (`inset 0 1px white/16%`), which is the "pressed glass" detail. Active press is `scale(0.97)`.
- Glass surfaces: `--glass-blur 12px` (dark 16px), opacity 80%, saturation 1.14.
- Easing `--ease-drawer: cubic-bezier(0.32,0.72,0,1)`. The status pulse uses stepped keyframes (`steps(6)`, 2s) so the compositor doesn't repaint every frame.
- Scrollbar is 6px, with thumb white 8% (hover 12%).

### Icons
**lucide-react** (`^0.564`; components.json `"iconLibrary": "lucide"`). Brand glyphs (provider logos, JetBrains) are custom SVG components.

### Component stack and notable components
shadcn-style primitives on **@base-ui/react** (style "base-mira", baseColor zinc, plus registries coss.com and spell.sh). Diffs use **@pierre/diffs** and file trees use **@pierre/trees**. Notable components:
- **Sidebar** (`Sidebar.tsx`, `LegacySidebar.tsx`): search row, a "All projects" picker, then thread rows. Each row has 3 lines: project name + age (`14h`, `2h`), a bold thread title, and branch/PR (`main`, `#7723`). A provider glyph sits at the right. A collapsed "Settled (143)" group holds finished threads. Pin and snooze are supported. Settings, branches and usage are icon buttons at the bottom-left. The sidebar header has a gradient "stage art" backdrop (`SidebarStageBackdrop`).
- **Thread status pill** (`resolveThreadStatusPill`): dot plus label, priority-ordered.
  - Pending Approval: amber `bg-amber-500 / dark:bg-amber-300/90`
  - Awaiting Input: indigo
  - Working / Connecting: sky with pulse
  - Plan Ready: violet
  - Monitoring: sky, no pulse
  - Completed (unseen): emerald

  Project rows roll up the highest-priority child status.
- **Chat:** assistant text is plain on the canvas with no bubble. User messages sit in a rounded `--message-surface` card on the right. "Worked for 3m 43s ›" collapses tool/narration work. A "2 changed files +29 −12 · Show files · Open diff" summary card sits at the end of a turn.
- **Diff panel** (right): per-turn selector ("Turn 2"), +/− counts in green/red, unified/split toggles, collapsed "1143 unmodified lines" separators, and line-number gutters with a coloured left bar for changed lines.
- **Composer:** floating rounded card with a soft drop shadow. Below it: model picker chip ("GPT-5.6-Sol ⌄"), attach button, round send button, and a context strip (Worktree · PR · branch).
- **Command palette** (`CommandPalette*.tsx`), file picker (Cmd+P), project search (Cmd+Shift+F), toasts (`ui/toast.tsx`), empty states (`NoActiveThreadState`, `NoProjectsHero`, `ui/empty.tsx`), and `ui/kbd.tsx` keyboard hints.

### Navigation model
- Left sidebar: project → threads list (tree when one project is selected, flat "All projects" otherwise). Center: thread chat. Right: a tabbed panel (Diff, Preview, …) toggled with Cmd+Alt+B. Bottom: terminal drawer (Cmd+J) with splits.
- Breadcrumb header: `project / thread title`, with action dropdowns on the right (new, environment, git).
- New thread: Cmd+N (Cmd+Shift+N local, Cmd+Alt+N without a project), or the compose icon next to Search.
- Settings: gear icon at the bottom-left of the sidebar, also reachable through the palette.

### Keyboard shortcuts (defaults, `packages/shared/src/keybindings.ts`)
| Area | Shortcuts |
|---|---|
| Palette and pickers | Cmd+K palette · Cmd+P file picker · Cmd+Shift+F project search |
| Panels | Cmd+B sidebar · Cmd+J terminal · Cmd+Alt+B right panel · Cmd+D diff (terminal split when the terminal has focus) · Cmd+Shift+J preview |
| Threads | Cmd+N new chat · Cmd+Shift+[ / ] previous/next thread · Cmd+1…9 jump to thread (desktop) · Cmd+[ / ] back/forward · Cmd+Shift+P pin · Cmd+Shift+S settle |
| Composer and model | Cmd+Shift+M model picker · Cmd+Shift+E effort · Cmd+Shift+A mode · Cmd+S stash composer · Cmd+Shift+Enter steer queued message |
| Theme | Cmd+Alt+A theme picker |

Every binding is user-overridable with `when` clauses (`terminalFocus`, `previewFocus`, …).

### Why it feels polished
- One neutral-black canvas, with surfaces only +3–4% white and hairline 6% borders.
- Semantic geometry tokens, so the sidebar, palette and tooltip can't drift apart.
- Dense secondary text (11–12px muted) under a 14px primary line.
- Tactile micro-details: 0.97 press scale, inset top highlight on buttons, stepped status pulse, drawer easing.
- Status reduced to one coloured dot + label with a strict priority order.
- Long work collapses ("Worked for…") so the transcript stays scannable.

Screenshots: `t3-site.png`, `t3-site-full.png`, `t3-repo-app-desktop.png` (the official app screenshot from `apps/marketing/src/assets/app-desktop.webp`, rendered to PNG).

---

## 2. herdr (agent-aware terminal multiplexer, Rust/ratatui TUI)

Note: the opentechhub.io page is a third-party listing. Its CSS did not load through the proxy, so `herdr-opentechhub.png` is unstyled and not useful. The real sources are github.com/herdrdev/herdr and herdr.dev.

Sources: `src/app/state.rs` (`Palette`), `src/config/theme.rs`, `src/client/shell.rs` (status glyphs/colours), `src/ui/sidebar*.rs`, `docs/next/website/src/content/docs/{concepts,keyboard}.mdx`, herdr.dev live CSS (`/css/style.css`, `/css/site.css`), and computed styles.

### Fonts
- **App:** whatever monospace font your terminal uses. herdr renders text cells and cannot set fonts.
- **Website (herdr.dev):**
  - Display: **Archivo** 900 (Google Fonts; weights 600/800/900), h1 95px with tracking −5.2px (≈ −0.055em).
  - Body: **Inter** 400/500/600 at 14.5px.
  - Labels and nav: **JetBrains Mono** (self-hosted `/assets/jbm.woff2`, weight 400–700), uppercase and widely letter-spaced ("THE AGENT RUNTIME", "DOCS PLUGINS BLOG"). `--mono` is used 75 times in their CSS.

### Color tokens
**App default theme: Catppuccin Mocha** (`Palette::catppuccin()`). 18 built-ins exist (tokyo-night, dracula, nord, gruvbox, one-dark, solarized, kanagawa, rose-pine, vesper, plus light variants), and each token can be overridden in `[theme.custom]`.

| Token (purpose per source comment) | Hex |
|---|---|
| `accent` (active borders, highlight) | `#89b4fa` |
| `panel_bg` (tab bar, floating panels, modals) | `#181825` |
| `sidebar_bg` | terminal default (Reset) |
| `active_row_bg` / `surface_dim` | `#1e1e2e` |
| `selection_bg` / `surface0` | `#313244` |
| `surface1` (hover) | `#45475a` |
| `overlay0` (muted numbers) | `#6c7086` |
| `overlay1` | `#7f849c` |
| `text` | `#cdd6f4` |
| `subtext0` | `#a6adc8` |
| `mauve` (branch names) | `#cba6f7` |
| `green` → **idle** (seen) | `#a6e3a1` |
| `yellow` → **working** | `#f9e2af` |
| `red` → **blocked** (needs you) | `#f38ba8` |
| `teal` → **done, unseen** | `#94e2d5` |
| `blue` | `#89b4fa` |
| `peach` (interrupted/warn) | `#fab387` |

The Latte light theme mirrors this: accent `#1e66f5`, panel `#eff1f5`, text `#4c4f69`, red `#d20f39`, green `#40a02b`, yellow `#df8e1d`.

**Website "ink" mode:**

| Token | Hex |
|---|---|
| `--bg` | `#17171a` |
| `--panel` | `#1e1e22` |
| `--mass` / `--line` | `#26262b` |
| `--line2` | `#35353d` |
| `--grid` | `#202024` |
| `--ink` (text) | `#eae8ee` |
| `--dim` | `#cdccd2` |
| `--faint` | `#b0afb6` |
| `--faint2` | `#908f96` |
| `--spot` (accent, Catppuccin mauve) | `#cba6f7` |

"Paper" mode: bg `#efece5`, ink `#15140f`, spot `#8839ef`. Website status swatches: run `#5fae74`, wait `#d3a027`, idle `#5a615c`, done `#6f6a86`.

### Radii, spacing, shadows
- Website: `--radius-sm 2px`, `--radius-md 4px`, `--radius-lg 6px`, and 0 in an alternate mode. Square, hairline-bordered boxes with no shadows. `--gut: 34px` page gutter.
- App: box-drawing borders. Only the focused pane gets an accent-coloured border; the others get dim ones (`ui.pane_borders = auto|on|off`).

### Icons
No icon library. Status uses text glyphs.
- Default "dots" style: `●` working/blocked/done, `○` idle, `·` unknown, coloured by state.
- Optional "symbols" style: `◐` working, `×` blocked, `✓` done, `○` idle.
- Git status: `↑n ↓n`.

### Density
Maximal. One terminal cell per glyph, sidebar rows of 1–2 lines, and state text right-aligned in dim colour.

### Notable components (seen in `herdr-repo-screenshot.png`)
- **Left sidebar, two sections.**
  - Top, "spaces": numbered workspaces (`1 herdr ●`, branch `master` underneath in mauve, `2 pi-extensions ●`). The active row has an `active_row_bg` fill.
  - Bottom, "agents": the agent name on the left and its state word right-aligned (`pi idle`, `claude working`), with a coloured glyph before it.
  - Rows are configurable token templates (`state_icon`, `workspace`, `branch`, `agent`, `git_status`, …).
- **Pane grid:** tmux-style splits. Focused pane has a blue accent border. A tab bar sits at the top (website demo: active tab filled with `--spot` mauve and dark text).
- **Goto picker** (`prefix+g`): one row per agent/terminal grouped by workspace. `/` searches; `b/w/i/d` filter blocked/working/idle/done; `a` shows all; the selected path appears below.
- **Keybinding help overlay** (`prefix+?`) with `/` filter.
- **Roll-up:** workspace status = highest-priority child (blocked 4 > done 3 > working 2 > idle 1).
- **Per-client "seen" tracking.** "done" means finished and not yet looked at. It becomes "idle" once viewed, so a completed agent stays visibly different until you look at it.
- **Sounds and OS notifications** on state change (`src/sound.rs`, `terminal_notify.rs`).

### Navigation model
- Hierarchy: session → workspace (one per repo/task) → tab (layout) → pane (real terminal), with an agent detected inside each pane.
- Mouse-native: click panes, tabs, workspaces and agents; drag split borders; right-click menus. The keyboard is an optional layer on top.
- New workspace: `prefix+shift+n`. New tab: `prefix+c`. Split: `prefix+v` / `prefix+minus`.
- Settings: TOML config file only (`[theme]`, `[keys]`, `[ui]`). No in-app settings UI was found in source.

### Keyboard shortcuts (prefix = Ctrl+B)
| Area | Shortcuts |
|---|---|
| Tabs | `c` new tab · `n`/`p` next/prev · `1..9` jump · `shift+t` rename · `shift+x` close |
| Panes | `v` split right · `minus` split down · `h/j/k/l` focus · `shift+h/j/k/l` swap · `z` zoom · `x` close · `r` resize mode · `[` copy mode |
| Workspaces | `w` workspace navigation · `shift+n` new · `shift+w` rename · `shift+d` close · `g` goto picker |
| Other | `b` toggle sidebar · `q` detach · `?` help |

The docs recommend `ctrl+alt+<key>` as prefix-free chords, because almost no terminal or desktop environment claims them.

### Why it feels polished
- A fixed, small semantic palette where each state owns one colour and one glyph.
- The "done vs idle" distinction (unseen vs seen).
- Workspace roll-up, so you never hunt for the stuck agent.
- One accent used only for the focused pane border.
- Branch name always visible in a secondary hue.
- On the website: a confident editorial look (Archivo 900 + mono caps labels + hairline grid) with zero shadows.

Screenshots: `herdr-repo-screenshot.png` (official app screenshot from the repo), `herdr-site.png`, `herdr-site-full.png`, `herdr-docs-concepts.png`, `herdr-docs-keyboard.png`, `herdr-opentechhub.png` (unstyled, ignore).

---

## 3. Odysseus (self-hosted AI workspace, vanilla JS + one 41k-line CSS)

Sources: `static/style.css`, `static/js/theme.js`, `static/js/settings.js` (`SHORTCUT_DEFAULTS`), `static/js/keyboard-shortcuts.js`, `static/index.html`, and `static/fonts/`.

### Fonts
- **Default app font is monospace:** `var(--font-family, 'Fira Code', monospace)`. Fira Code is self-hosted at weights 300/400/600 (OFL).
- Font options: `mono` (Fira Code), `sans` (`system-ui, -apple-system, 'Segoe UI', sans-serif`), `serif` (Georgia), and `opendyslexic` (OFL, bundled). Custom fonts can be uploaded.
- **Inter** (bundled 400/500/600) is used for modals and settings on desktop (≥769px): `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`, 14px, `letter-spacing: -0.015em`.
- Density classes: compact = root 13px, comfortable (default), spacious = 16px. Optional 125% UI scale.

### Color tokens (default "dark" preset)
Each theme is only **5 colours**: `bg, fg, panel, border, red(=accent)`. Everything else is derived (`computeAdvancedDefaults`): user bubble = bg, AI bubble = panel, sidebar = panel, send button = accent, and so on.

| Role | Hex |
|---|---|
| `--bg` (main canvas) | `#282c34` (One Dark) |
| `--panel` (sidebar, AI bubble, input) | `#111111` |
| `--border` | `#355a66` (teal-slate) |
| `--fg` (text) | `#9cdef2` (cyan-tinted) |
| `--red` (accent: brand, send button, scrollbar thumb) | `#e06c75` |
| muted | `#888` / `#6b7280` |
| success | `#4caf50` (also `--green #50fa7b`) |
| warning | `#f0ad4e` |
| error | `#ff4444` · danger `#c0392b` |
| link/accent blue | `#00aaff` |
| syntax (One Dark) | kw `#c678dd`, str `#e5c07b`, fn `#61afef`, num `#d19a66`, comment `#828997`, code bg `#1e2228` |

Other presets include midnight (GitHub dark: `#0d1117/#c9d1d9/#161b22/#30363d/#f85149`), "claude" (`#262624/#f5f4f0/#30302e/#4a4a47/#c6613f`), "gpt", paper, and many fun ones. Light: bg `#f0ebe3`, fg `#5a5248`, panel `#faf6f0`, border `#d4cdc2`, accent `#c47d5a`.

### Radii, spacing, shadows
- The most common radii are 6px (245 uses), 4px (204), 50% (dots/avatars), 8px (129) and 999px pills.
- Chat bubbles use 18px with one squared "tail" corner: user `18px 18px 0 18px`, AI `18px 18px 18px 0`. Bubble padding is 10px 12px and max-width 85%.
- Modals: 10px radius, `0 8px 32px rgba(0,0,0,.45)`. Composer: large rounded card (≈16px) with a 1px border.
- Scrollbar: 8px with an accent-coloured thumb.
- Messages animate in (`msg-enter 0.3s`).

### Icons
Inline SVGs in **Lucide style** (24 viewBox, stroke-width 2). 187 icons in index.html use stroke 2, and a code comment says "matching Lucide style". No icon package is used. In the sidebar the icons are tinted with the accent (`--red`).

### Density
Medium. Sidebar rows ≈30px, with 12–13px Fira Code text in the sidebar.

### Notable components (`odysseus-repo-browser.jpg`, `odysseus-local-static-ui.png`)
- **Left sidebar.** A hamburger and a wordmark ("Odysseus" in accent) at the top. Then a flat nav list: New Chat, Search, Chats ›, Email +, Tools ⌄ (Brain, Calendar, Compare, Cookbook, Deep Research, Gallery, Library, Notes, Tasks, Theme). At the bottom: user avatar and a settings gear.
  - Inline status in a row: "Cookbook  idle ●" (green dot).
  - Shift-clicking the sidebar toggle moves the sidebar to the other side.
- **Empty state:** centred logo + wordmark in the accent colour, tagline "Yours for the voyage.", a rotating tip line, and a privacy pill ("Nobody").
- **Composer:** dark rounded card. Model chip top-right ("MiniMax-M2.7 ⌃"), tool toggles bottom-left (search, terminal `>_`), a segmented **Agent | Chat** toggle, and an accent send button.
- **Tool windows** (calendar, notes, cookbook, …) are draggable, resizable floating windows with snap zones and z-ordering (`windowDrag.js`, `windowResize.js`, `tileManager.js`, `modalSnap.js`, `toolWindowZOrder.js`). There are also left/right "docks".
- **Toast:** top-right dark panel with red monospace text and a × close button (visible in the local render as "Failed to load sessions…", because the backend wasn't running).
- **Theme editor:** five base colours plus "advanced" overrides, a harmony generator (complementary/analogous/triadic), background patterns (dots, synapse, perlin-flow, …) and frosted glass.

### Navigation model
- Sidebar-first. Sessions sit under "Chats". Right-click a session to rename, delete or set memory options.
- Tools open as floating windows over the chat rather than as routes.
- New chat: sidebar button or Ctrl+Alt+N. Settings: gear at the bottom-left or Ctrl+,.

### Keyboard shortcuts (`SHORTCUT_DEFAULTS`, all rebindable)
- Ctrl+K search · Ctrl+B sidebar (another default table in `keyboard-shortcuts.js` says Ctrl+Alt+B, so the source is inconsistent) · Ctrl+Alt+N new session · Ctrl+Alt+F favourite · Ctrl+Alt+D delete session
- Ctrl+, settings · Ctrl+/ focus input · Esc cancel · Alt+Shift+T TTS · Ctrl+Alt+I incognito · Ctrl+Alt+C calendar
- Also slash commands in the composer (`slashCommands.js`, `slashAutocomplete.js`).

### Why it feels polished / distinctive
- A strong personality from just 5 colours: monospace everywhere, a cyan-on-slate palette with a coral accent.
- A themeable derivation system: everything is computed from those 5 colours.
- Floating, snappable tool windows.
- Density and UI-scale settings for accessibility.

Weaknesses to avoid copying:
- Low-contrast muted text in the empty state.
- A monolithic CSS file with many hard-coded literals.
- An all-monospace UI hurts long-prose readability.

Screenshots: `odysseus-repo-browser.jpg` (official), `odysseus-local-static-ui.png` (static frontend served locally with no backend).

---

## What hive should take from each

### From T3 Code
1. **Surface model.** One near-black canvas. Raised surfaces are canvas + 3–4% white, borders are white 6–8%, and nothing is a separate mid-grey. Implement this as CSS variables using `color-mix()` / alpha so light and dark share the same structure.
2. **Semantic geometry tokens.** Use `--control-radius: 8px`, `--radius: 10px`, a 28px row and control height (24px for xs), 16px icons (14px in small controls), and shared insets (`--pane-inset`, `--sidebar-row-inset: 10px`), so pane headers, the palette and menus line up.
3. **Status pill.** A 6–8px dot plus an 11–12px label, with a fixed priority order (needs-approval > awaiting-input > error > working (stepped 2s pulse) > done-unseen > idle). Roll it up to group/project level, and reuse it in pane headers and the sidebar.
4. **Command palette and shortcut set.** Cmd/Ctrl+K palette; Cmd+1…9 to focus pane N; Cmd+Shift+[ / ] for previous/next pane; Cmd+B sidebar; Cmd+J drawer; Cmd+D diff. Render every shortcut with a `<kbd>` hint in menus and tooltips. Keep bindings data-driven with `when` contexts, as in `keybindings.ts`.
5. **Collapsed work and change summary.** In each agent pane, fold tool calls into "Worked for 3m 43s ›". End each turn with a "N changed files +A −D · Open diff" card. Use lucide icons (hive already has `Icons.tsx`; standardise on lucide geometry with stroke 1.75–2 at 16px).

### From herdr
1. **The 4-state agent model with unseen tracking:** working / blocked (needs you) / done (finished and **not yet viewed**) / idle (viewed). Flip done → idle when the pane gets focus. Make "done" visually louder than idle.
2. **One colour + one glyph per state**, optionally switchable to symbols for colour-blind users (`◐ × ✓ ○`). Use Catppuccin-like pastel hues on dark so the dots read without shouting.
3. **Focused-pane accent border.** Only the focused pane in the grid gets a 1px accent border (others use the hairline border). The pane header shows `agent · state` right-aligned plus the branch in a secondary hue.
4. **Goto/jump picker** (e.g. Cmd+G or inside Cmd+K): one row per pane grouped by workspace, with single-key filters `b/w/i/d` and a path/branch preview line. Also add a sidebar "agents" section listing every pane with its state word right-aligned.
5. **Prefix-free chord advice.** If hive needs global chords that must not collide with terminals inside panes, use `Ctrl+Alt+<key>` on Linux/Windows.

### From Odysseus
1. **Theme from a few base colours.** Define a theme as about 5–6 inputs (bg, panel, fg, border, accent, plus optional hue) and derive the rest (hover, selection, bubbles, code bg) with `color-mix()`. That makes user themes cheap.
2. **Density and scale settings.** Compact (13px) / comfortable (14px) / spacious (16px) by changing the root font size and the row-padding tokens. Useful for a pane grid where people want to fit 6–9 panes.
3. **Polished empty state.** Centred mark, one-line tagline, a rotating keyboard tip ("Tip: Ctrl+K to jump to any agent") and a primary "New agent" action. Use it for empty panes and for a grid with no agents.
4. **Segmented mode toggle and model chip in the composer.** For example `Agent | Chat`, or hive's per-pane mode, plus a model chip in the composer's top-right.
5. **Mono-flavoured accents without an all-mono UI.** Use monospace for labels and metadata (branch, model, counts, timestamps), as Odysseus and herdr.dev do, but keep prose in a sans font.

---

## Proposed unified token set for hive

Fonts, both bundled locally (no CDN):
- **Inter** (variable, SIL Open Font License 1.1, github.com/rsms/inter; npm `@fontsource-variable/inter`) for UI at 13px base, `letter-spacing: -0.01em` for ≤14px, and `font-feature-settings: "cv11","ss01"` (single-storey a, open digits; both optional).
- **JetBrains Mono** (variable, SIL OFL 1.1, github.com/JetBrains/JetBrainsMono; npm `@fontsource-variable/jetbrains-mono`) for terminal/code at 12.5–13px and for metadata labels at 11px, uppercase with 0.06em tracking for section headers.
- Alternatives, also OFL 1.1: DM Sans (T3 marketing), Fira Code (Odysseus). Licence: OFL allows bundling and redistribution in an app. Ship the `OFL.txt` alongside the woff2 files and don't sell the font standalone.

```css
@font-face { font-family: "Inter"; src: url("./fonts/InterVariable.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("./fonts/JetBrainsMono[wght].woff2") format("woff2"); font-weight: 100 800; font-display: swap; }

:root {
  /* type */
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --text-3xs: 10px; --text-2xs: 11px; --text-xs: 12px; --text-sm: 13px; --text-md: 14px; --text-lg: 16px;
  --tracking-tight: -0.01em; --tracking-label: 0.06em;

  /* geometry (T3-style semantic) */
  --radius-sm: 4px; --radius-control: 6px; --radius: 8px; --radius-lg: 12px; --radius-pill: 999px;
  --row-h: 28px; --row-h-sm: 24px; --header-h: 36px; --topbar-h: 44px;
  --icon: 16px; --icon-sm: 14px; --icon-stroke: 1.75;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px;
  --pane-gap: 6px; --sidebar-w: 260px;
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  --dur-fast: 120ms; --dur: 180ms;

  /* ---- dark (default) ---- */
  color-scheme: dark;
  --bg-0: #0b0b0d;          /* window chrome / grid gutter */
  --bg-1: #111114;          /* panes, sidebar */
  --bg-2: #17171b;          /* raised: composer, cards, inputs, popovers */
  --bg-3: #1e1e23;          /* hover */
  --bg-4: #26262c;          /* active / selected row */
  --border: #222227;        /* ≈ white 7% on bg-1 */
  --border-strong: #303037; /* ≈ white 12% */
  --text: #ececf1;
  --text-2: #a1a1aa;        /* secondary */
  --text-3: #71717a;        /* muted, timestamps, placeholders */
  --accent: #8b93ff;        /* indigo-ish; focus ring, focused-pane border, primary buttons */
  --accent-strong: #6366f1;
  --accent-fg: #0b0b0d;
  --accent-soft: rgb(139 147 255 / 0.14);
  --branch: #cba6f7;        /* herdr mauve for branch / worktree labels */

  /* agent state (herdr semantics, T3 hues) */
  --st-working: #7dd3fc;    /* sky-300, stepped pulse */
  --st-blocked: #fbbf24;    /* amber-400: needs approval / input from you */
  --st-done: #6ee7b7;       /* emerald-300: finished, unseen */
  --st-idle: #52525b;       /* zinc-600: finished, seen */
  --st-error: #f87171;      /* red-400 */
  --st-plan: #c4b5fd;       /* violet-300: plan ready */

  /* semantic */
  --success: #34d399; --warning: #fbbf24; --error: #f87171; --info: #60a5fa;
  --success-soft: rgb(52 211 153 / 0.14); --warning-soft: rgb(251 191 36 / 0.14); --error-soft: rgb(248 113 113 / 0.16);
  --diff-add-bg: rgb(52 211 153 / 0.10); --diff-add-fg: #34d399; --diff-del-bg: rgb(248 113 113 / 0.10); --diff-del-fg: #f87171;
  --code-bg: #0e0e11;
  --term-bg: var(--bg-1); --term-fg: var(--text); --term-cursor: #b4cbff; --term-selection: rgb(180 203 255 / 0.25);

  --shadow-pop: 0 8px 24px -8px rgb(0 0 0 / 0.6), 0 0 0 1px var(--border);
  --shadow-composer: 0 14px 32px -18px rgb(0 0 0 / 0.75);
  --highlight-inset: inset 0 1px 0 rgb(255 255 255 / 0.06);
  --scrollbar: rgb(255 255 255 / 0.08); --scrollbar-hover: rgb(255 255 255 / 0.14);
}

/* ---- light (optional) ---- */
:root[data-theme="light"] {
  color-scheme: light;
  --bg-0: #f4f4f5; --bg-1: #fcfcfc; --bg-2: #ffffff; --bg-3: #f4f4f5; --bg-4: #e9e9ec;
  --border: #e4e4e7; --border-strong: #d4d4d8;
  --text: #27272a; --text-2: #52525b; --text-3: #71717a;
  --accent: #4f46e5; --accent-strong: #4338ca; --accent-fg: #ffffff; --accent-soft: rgb(79 70 229 / 0.10);
  --branch: #8839ef;
  --st-working: #0284c7; --st-blocked: #d97706; --st-done: #059669; --st-idle: #a1a1aa; --st-error: #dc2626; --st-plan: #7c3aed;
  --success: #059669; --warning: #d97706; --error: #dc2626; --info: #2563eb;
  --code-bg: #f7f7f8; --term-cursor: #26384e; --term-selection: rgb(37 63 99 / 0.20);
  --shadow-pop: 0 8px 24px -10px rgb(0 0 0 / 0.18), 0 0 0 1px var(--border);
  --highlight-inset: inset 0 1px 0 rgb(255 255 255 / 0.6);
  --scrollbar: rgb(0 0 0 / 0.15); --scrollbar-hover: rgb(0 0 0 / 0.25);
}

/* density (Odysseus idea) */
:root[data-density="compact"]  { --text-sm: 12px; --row-h: 24px; --header-h: 30px; --pane-gap: 4px; }
:root[data-density="spacious"] { --text-sm: 14px; --row-h: 32px; --header-h: 40px; --pane-gap: 8px; }

body { background: var(--bg-0); color: var(--text); font: 400 var(--text-sm)/1.45 var(--font-sans);
       letter-spacing: var(--tracking-tight); -webkit-font-smoothing: antialiased; }

/* stepped pulse (T3) */
@keyframes hive-pulse { 0%,40% { opacity: 1 } 50%,90% { opacity: .45 } 100% { opacity: 1 } }
.status-dot[data-state="working"] { animation: hive-pulse 2s steps(6) infinite; }
```

Notes:
- Dark and light hexes are my proposal, based on T3's zinc/neutral scale, herdr's mauve and state semantics, and Tailwind 300/400 tints. Run a contrast check before adopting: `--text-3` `#71717a` on `#111114` is about 4.1:1, which is fine for metadata but not body text.
- If hive keeps its own `--mono` variable (currently used 15 times in the renderer CSS), alias `--mono: var(--font-mono)`.

---

## Could not verify
- The live t3.codes app UI. I only have the marketing site and the official app screenshot from the repo; I did not run the T3 desktop app.
- GitHub repo pages: Playwright timed out or got `ERR_TOO_MANY_RETRIES` through the proxy, so there are no GitHub screenshots.
- `www.herdr.dev` failed, but `herdr.dev` worked.
- The opentechhub listing rendered without CSS.
- Odysseus was rendered from its static frontend without a backend, so there is no session list, messages or tool-call rendering in the screenshot. Message and tool styles come from CSS reading only.
- herdr's in-app sidebar colours were read from source and its README screenshot, not from running the binary.
- OKLCH → hex conversions marked ≈ are approximate.

## Files saved (`/home/user/hargent/audit/evidence/design/`)
- `DESIGN-STUDY.md`: this report
- `t3-site.png`, `t3-site-full.png`: t3.codes, 1440x900 and full page
- `t3-repo-app-desktop.png`: official T3 Code app screenshot (from repo marketing assets)
- `herdr-repo-screenshot.png`: official herdr TUI screenshot (repo `assets/screenshot.png`)
- `herdr-site.png`, `herdr-site-full.png`: herdr.dev
- `herdr-docs-concepts.png`, `herdr-docs-keyboard.png`: herdr docs
- `herdr-opentechhub.png`: opentechhub listing (unstyled; low value)
- `odysseus-repo-browser.jpg`: official Odysseus screenshot (repo `assets/branding`)
- `odysseus-local-static-ui.png`: Odysseus static frontend rendered locally at 1440x900 (shows the toast style)

## What shipped (2026-10-01)

| From | Taken | Where |
|---|---|---|
| T3 Code | Command palette (Ctrl+K) with shortcuts shown; "Worked for Xm Ys" fold of a finished turn's tool calls; Inter + JetBrains Mono (bundled, OFL); layered neutral grays | `Palette.tsx`, `Pane.tsx` `foldTurns`, `styles.css` tokens |
| herdr | One state model (needs you > error > working > done > idle) as a dot + word everywhere: sidebar, pane header, palette, group roll-up; only the focused pane gets the accent border; numbered agents with Ctrl+1..9 and Ctrl+Shift+[ ] cycling; the 2×2 terminal grid | `state.tsx`, `Links.tsx` `GroupState`, `hive tui` |
| Odysseus | Quiet top bar (actions live in the palette), search row at the top of the sidebar, mono metadata line under each agent, light theme and density settings | `App.tsx` `TopBar` / `Sidebar`, `data-theme` / `data-density` |

Screenshots after the change: `after-grid.png`, `after-palette.png`, `after-vertical.png`; terminal: `../tui-squad.png`.
