# Prioritized roadmap (after audit pass 4)

Done in passes 2–4: SEC-003 (guard), SEC-004 (mitigated), PERF-001, UX-008, UX-009, IDEA-001, IDEA-007 (verdict mode). Earlier: SEC-001, SEC-002, COST-001, BUG-001 to BUG-004, UX-001 to UX-007, A11Y-001 and A11Y-002, PRIV-001; SEC-003 mitigated.

1. **Safety residuals.** SEC-004 residual (by design): an agent allowed to run anything runs as you. Consider defaulting recipes to Codex (sandboxed writes) for allow-all automation.
2. **Most useful features found in the competitive research.**
   - IDEA-006: `.worktreeinclude`, to copy `.env` etc. into agent worktrees (small; unblocks real projects).
   - IDEA-005: chain on "agent finished", e.g. coder done → tester → reviewer (medium; builds on watch jobs).
3. **Polish.** IDEA-003 (per-pane mute, "ready" to chat), IDEA-004 (prompt-engineer round trip), bridge commands for held mail and verdicts.
4. **Later.** IDEA-002 (USD estimates, OpenRouter first), GitHub-event triggers by polling (no listener).

Verify each on a real Windows desktop and the Fedora laptop before relying on it daily.
