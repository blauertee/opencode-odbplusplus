// What the odb-part agent learned about one part, kept across chats and
// processes (docs/features/part-questions.md): where its datasheet is, the
// URLs that did not work, every answered question, and which child session
// holds the part's context in which chat.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CACHE_DIR } from "../cache.ts"

export const NOTES_SCHEMA_VERSION = 1
/** Sessions remembered per part; older chats drop out first. */
const MAX_SESSIONS = 20

export type DatasheetSource = "attribute" | "web"
export type AnswerSource = "datasheet" | "board" | "web" | "not-found"
export type Confidence = "high" | "medium" | "low"

export interface DatasheetRef {
  url: string
  source: DatasheetSource
  pages: number
  /** Whether the MPN was found in the text (always true for web datasheets of parts with an MPN). */
  mpnFound?: boolean
  at: string
}

export interface Answer {
  question: string
  answer: string
  pages: number[]
  confidence: Confidence
  source: AnswerSource
  /** Datasheet the answer was read from; a cached answer is only reused for the same one. */
  datasheet?: string
  refdes: string
  design: string
  at: string
}

export interface PartNotes {
  schemaVersion: number
  key: string
  mpn?: string
  manufacturer?: string
  datasheet?: DatasheetRef
  failedUrls: { url: string; reason: string; at: string }[]
  answers: Answer[]
  /** Root session (the user's chat) -> child session that holds this part's context there. */
  sessions: Record<string, { id: string; at: string }>
}

/** Notes are per MPN, so every refdes and design with that part shares them; parts without one are per design and refdes. */
export function partKey(mpn: string | undefined, fingerprint: string, refdes: string): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9._-]+/g, "_").slice(0, 80)
  return mpn ? `mpn-${clean(mpn)}` : `ref-${fingerprint.slice(0, 16)}-${clean(refdes)}`
}

/** Two questions are the same when they only differ in case, spacing and trailing punctuation. */
export function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[\s?.!]+$/, "").trim()
  return norm(a) === norm(b)
}

export class PartNotesStore {
  readonly dir: string

  constructor(dir = join(CACHE_DIR, "parts")) {
    this.dir = dir
  }

  read(key: string): PartNotes {
    try {
      const data = JSON.parse(readFileSync(this.path(key), "utf8")) as PartNotes
      if (data.schemaVersion === NOTES_SCHEMA_VERSION) return data
    } catch {}
    return { schemaVersion: NOTES_SCHEMA_VERSION, key, failedUrls: [], answers: [], sessions: {} }
  }

  write(notes: PartNotes): void {
    const sessions = Object.entries(notes.sessions).sort(([, a], [, b]) => b.at.localeCompare(a.at))
    notes.sessions = Object.fromEntries(sessions.slice(0, MAX_SESSIONS))
    mkdirSync(this.dir, { recursive: true })
    const path = this.path(notes.key)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(notes, null, 2) + "\n")
    // rename is atomic, so a concurrent reader never sees half a file
    renameSync(tmp, path)
  }

  delete(key: string): void {
    rmSync(this.path(key), { force: true })
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`)
  }
}

/** The notes as the agent sees them at the start of a session. */
export function notesSummary(n: PartNotes): string {
  const lines: string[] = []
  if (n.datasheet) {
    lines.push(`datasheet: ${n.datasheet.url} (${n.datasheet.source === "web" ? "found on the web" : "from the design's attribute"}, ${n.datasheet.pages} pages)`)
  }
  for (const f of n.failedUrls.slice(-5)) lines.push(`did not work: ${f.url} (${f.reason})`)
  if (n.answers.length) {
    lines.push(`earlier answers (${n.answers.length}${n.answers.length > 15 ? ", last 15 shown" : ""}):`)
    for (const a of n.answers.slice(-15)) {
      const pages = a.pages.length ? `, p. ${a.pages.join(", ")}` : ""
      lines.push(`- Q (${a.refdes}): ${a.question}\n  A (${a.source}${pages}, ${a.confidence}): ${a.answer.replace(/\n+/g, " ")}`)
    }
  }
  return lines.length ? lines.join("\n") : "nothing yet"
}
