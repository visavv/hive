/**
 * Keep a path inside a folder, following symlinks: a link inside the folder
 * that points outside it doesn't count as inside. Works for paths that don't
 * exist yet (a file about to be written): the nearest existing parent is
 * resolved and the rest appended.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** True if `child` (already absolute and real) is `root` or inside it. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

/** Real path of `p` (relative to `root`), or throws if it leaves `root`. */
export function confine(root: string, p: string, what = p): string {
  const rootReal = realpathSync(resolve(root));
  let cur = isAbsolute(p) ? resolve(p) : resolve(rootReal, p || ".");
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  const real = join(existsSync(cur) ? realpathSync(cur) : cur, ...rest);
  if (!isInside(rootReal, real)) throw new Error(`${what} is outside the working folder`);
  return real;
}
