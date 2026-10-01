/**
 * Kanban board: Draft → In progress → Done. Done cards drop out of sight (the
 * "abyss") but are kept and can be shown again. One board across all projects
 * (<HIVE_HOME>/board.db); a card may carry a project tag and labels. You, agents
 * (hive_card_* tools) and automations all add cards here.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hiveHome } from "../core/home.js";

export const COLUMNS = ["draft", "doing", "done"] as const;
export type Column = (typeof COLUMNS)[number];
export const COLUMN_LABEL: Record<Column, string> = { draft: "Draft", doing: "In progress", done: "Done" };

export interface Card {
  id: number;
  title: string;
  body: string;
  col: Column;
  pos: number;
  project: string;
  labels: string[];
  source: string; // "owner", an agent name, or an automation ("twitch", …)
  created: number;
  updated: number;
  doneAt: number | null;
}

interface Row extends Omit<Card, "labels" | "doneAt"> {
  labels: string;
  done_at: number | null;
}

const toCard = (r: Row): Card => ({ ...r, labels: r.labels ? r.labels.split(",").filter(Boolean) : [], doneAt: r.done_at });

export class Board {
  readonly db: Database.Database;
  constructor(path = join(hiveHome(), "board.db")) {
    mkdirSync(join(path, ".."), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        col TEXT NOT NULL DEFAULT 'draft',
        pos REAL NOT NULL DEFAULT 0,
        project TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'owner',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        done_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS cards_col ON cards(col, pos);
    `);
  }

  /** Cards in board order; Done is left out unless asked for. */
  list(o: { done?: boolean; project?: string; label?: string; q?: string } = {}): Card[] {
    const c: string[] = [];
    const a: (string | number)[] = [];
    if (!o.done) c.push("col != 'done'");
    if (o.project) (c.push("project = ?"), a.push(o.project));
    if (o.label) (c.push("(',' || labels || ',') LIKE ?"), a.push(`%,${o.label},%`));
    if (o.q) (c.push("(title LIKE ? OR body LIKE ?)"), a.push(`%${o.q}%`, `%${o.q}%`));
    const rows = this.db
      .prepare(`SELECT * FROM cards ${c.length ? "WHERE " + c.join(" AND ") : ""} ORDER BY CASE col WHEN 'draft' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END, ${o.done ? "COALESCE(done_at, 0) DESC," : ""} pos, id`)
      .all(...a) as Row[];
    return rows.map(toCard);
  }

  get(id: number): Card | undefined {
    const r = this.db.prepare(`SELECT * FROM cards WHERE id=?`).get(id) as Row | undefined;
    return r && toCard(r);
  }

  add(c: { title: string; body?: string; col?: Column; project?: string; labels?: string[]; source?: string }): Card {
    const title = c.title.trim().slice(0, 300);
    if (!title) throw new Error("a card needs a title");
    const col = c.col ?? "draft";
    if (!COLUMNS.includes(col)) throw new Error(`column is one of ${COLUMNS.join(", ")}`);
    const now = Date.now();
    // new cards go to the top of their column
    const top = (this.db.prepare(`SELECT MIN(pos) AS p FROM cards WHERE col=?`).get(col) as { p: number | null }).p;
    const id = this.db
      .prepare(`INSERT INTO cards (title, body, col, pos, project, labels, source, created, updated, done_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(title, (c.body ?? "").slice(0, 20_000), col, (top ?? 1) - 1, c.project ?? "", cleanLabels(c.labels).join(","), c.source ?? "owner", now, now, col === "done" ? now : null)
      .lastInsertRowid as number;
    return this.get(id)!;
  }

  /** Move a card to a column, optionally before another card (drag and drop); default: top of the column. */
  move(id: number, col: Column, before?: number | null): Card {
    if (!COLUMNS.includes(col)) throw new Error(`column is one of ${COLUMNS.join(", ")}`);
    const card = this.get(id);
    if (!card) throw new Error(`no card #${id}`);
    let pos: number;
    const ref = before != null ? this.get(before) : undefined;
    if (ref && ref.col === col && ref.id !== id) {
      const prev = this.db.prepare(`SELECT pos FROM cards WHERE col=? AND pos < ? AND id != ? ORDER BY pos DESC LIMIT 1`).get(col, ref.pos, id) as { pos: number } | undefined;
      pos = prev ? (prev.pos + ref.pos) / 2 : ref.pos - 1;
    } else if (before === null) {
      // explicit "end of column"
      const last = (this.db.prepare(`SELECT MAX(pos) AS p FROM cards WHERE col=? AND id != ?`).get(col, id) as { p: number | null }).p;
      pos = (last ?? 0) + 1;
    } else {
      const top = (this.db.prepare(`SELECT MIN(pos) AS p FROM cards WHERE col=? AND id != ?`).get(col, id) as { p: number | null }).p;
      pos = (top ?? 1) - 1;
    }
    const now = Date.now();
    this.db.prepare(`UPDATE cards SET col=?, pos=?, updated=?, done_at=? WHERE id=?`).run(col, pos, now, col === "done" ? (card.col === "done" ? card.doneAt : now) : null, id);
    return this.get(id)!;
  }

  update(id: number, p: { title?: string; body?: string; project?: string; labels?: string[] }): Card {
    const card = this.get(id);
    if (!card) throw new Error(`no card #${id}`);
    const title = p.title != null ? p.title.trim().slice(0, 300) : card.title;
    if (!title) throw new Error("a card needs a title");
    this.db
      .prepare(`UPDATE cards SET title=?, body=?, project=?, labels=?, updated=? WHERE id=?`)
      .run(title, p.body != null ? p.body.slice(0, 20_000) : card.body, p.project ?? card.project, p.labels ? cleanLabels(p.labels).join(",") : card.labels.join(","), Date.now(), id);
    return this.get(id)!;
  }

  remove(id: number): boolean {
    return this.db.prepare(`DELETE FROM cards WHERE id=?`).run(id).changes > 0;
  }

  /** How many cards are in each column (Done included, since it's hidden). */
  counts(): Record<Column, number> {
    const out: Record<Column, number> = { draft: 0, doing: 0, done: 0 };
    for (const r of this.db.prepare(`SELECT col, COUNT(*) AS n FROM cards GROUP BY col`).all() as { col: Column; n: number }[]) out[r.col] = r.n;
    return out;
  }

  close() {
    this.db.close();
  }
}

function cleanLabels(l?: string[]): string[] {
  return [...new Set((l ?? []).map((x) => x.trim().toLowerCase().replace(/[^\w.-]+/g, "-").slice(0, 30)).filter(Boolean))].slice(0, 8);
}

let shared: Board | undefined;
/** One board per process (the db is shared across processes through SQLite). */
export function board(): Board {
  if (!shared || !shared.db.open) shared = new Board();
  return shared;
}
