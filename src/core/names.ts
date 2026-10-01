/** Agent name rules, shared by the hub, the CLI and the UI (no Node imports). */
export const RESERVED_NAMES = ["owner", "hive", "bridge"];

/** What's wrong with an agent name, or undefined if it's fine. Names become branch names, paths and mail addresses. */
export function agentNameProblem(n: string): string | undefined {
  if (!n) return "give it a name";
  if (n.length > 40) return `too long (${n.length} characters, max 40)`;
  if (/\s/.test(n)) return "no spaces (use - or _)";
  if (/^[.-]/.test(n)) return "can't start with . or -";
  const bad = [...new Set(n.replace(/[\w.-]/g, ""))];
  if (bad.length) return `only letters a-z, digits, _ . - (not ${bad.map((c) => `"${c}"`).join(" ")})`;
  if (RESERVED_NAMES.includes(n.toLowerCase())) return `"${n}" is reserved${n.toLowerCase() === "owner" ? " for you (the human)" : " by hive"}`;
  return undefined;
}
