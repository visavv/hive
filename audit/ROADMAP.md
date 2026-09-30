# Prioritized roadmap (from audit pass 1)

1. **Close the permission gaps (small, high leverage).** SEC-001: cap repo and user skill policies. SEC-002: resolve symlinks with realpath in the API agent and media. BUG-001: `relative()` in skill output. Together these are about half a day and remove every "leave the folder" and "grant yourself allow-all" path found.
2. **Safe spending defaults.** COST-001: a default daily token cap for API providers plus a first-run notice in the Usage tab. BUG-002: charge media only on success and show media as its own row.
3. **Trust between agents.** SEC-003 / IDEA-001: label peer mail as untrusted in wake prompts; add optional `accept_from`; ask before follow-ups that target `allow-all` agents.
4. **Small UX fixes.** UX-001 (reserved names), UX-002 (specific name errors), UX-003 (URL validation, doctor ✗ on unreachable).
5. **Features once 1–4 are done.** IDEA-003 (per-pane mute, ready to chat), IDEA-004 (prompt-engineer round trip), IDEA-002 (USD estimates, OpenRouter first).

Dependencies: 3 builds on the policy work in 1. 2 needs no other changes.
