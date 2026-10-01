# Prioritized roadmap (after audit pass 3)

Done in passes 2–3: SEC-001, SEC-002, COST-001, BUG-001 to BUG-004, UX-001 to UX-007, A11Y-001 and A11Y-002, PRIV-001; SEC-003 mitigated.

1. **Safety residuals.** SEC-004: show a warning when choosing allow-all outside a worktree, and default recipes to Codex for allow-all automation where possible. IDEA-001 (trusted senders / accept list) finishes SEC-003.
2. **Most useful features found in the competitive research.**
   - IDEA-006: `.worktreeinclude`, to copy `.env` etc. into agent worktrees (small; unblocks real projects).
   - IDEA-005: chain on "agent finished", e.g. coder done → tester → reviewer (medium; builds on watch jobs).
   - IDEA-007: best-of-n for skills across models, compared blind (medium; high value for titles and prompts).
3. **Polish.** UX-008 (toast position), IDEA-003 (per-pane mute, "ready" to chat), IDEA-004 (prompt-engineer round trip), PERF-001 index if hives get large.
4. **Later.** IDEA-002 (USD estimates, OpenRouter first), GitHub-event triggers by polling (no listener).

Verify each on a real Windows desktop and the Fedora laptop before relying on it daily.
