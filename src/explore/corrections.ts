// User corrections: <design>.understanding.md next to the archive
// (docs/features/board-exploration.md). Hand-edited Markdown, so parsing is
// lenient and editing touches only the lines it owns. The cache never
// overrides what is in here.
//
//   # Board
//   Free text about the board.
//   title: ...
//   function: ...          (purpose: is accepted too)
//
//   ## Block USB3          ("## USB3" works as well)
//   title: USB-C 3.2 host port
//   function: SuperSpeed port with orientation mux; no PD.
//   parts: +R12 -U19
//   Free text, kept as notes.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PartMoves } from "../overview.ts"

export interface SectionCorrection {
  title?: string
  function?: string
  add: string[]
  remove: string[]
  /** Free text lines, verbatim (blank lines dropped). */
  notes: string[]
}

export interface Corrections {
  path: string
  exists: boolean
  board: SectionCorrection
  /** Block name as written in the heading -> its corrections */
  blocks: Map<string, SectionCorrection>
  errors: string[]
}

const BOARD_HEADING = /^#\s+board\s*$/i
const BLOCK_HEADING = /^##\s+(?:block\s+)?(.+?)\s*$/i
const ANY_HEADING = /^#{1,6}\s/
const KEY_LINE = /^(title|function|purpose|parts)\s*:\s*(.*)$/i
const PART_TOKEN = /^([+-])(\S+)$/

export function correctionsPath(designsDir: string, stem: string): string {
  return join(designsDir, `${stem}.understanding.md`)
}

const empty = (): SectionCorrection => ({ add: [], remove: [], notes: [] })

export function readCorrections(designsDir: string, stem: string): Corrections {
  const path = correctionsPath(designsDir, stem)
  if (!existsSync(path)) return { path, exists: false, board: empty(), blocks: new Map(), errors: [] }
  return { path, exists: true, ...parseCorrections(readFileSync(path, "utf8")) }
}

export function parseCorrections(text: string): Omit<Corrections, "path" | "exists"> {
  const board = empty()
  const blocks = new Map<string, SectionCorrection>()
  const errors: string[] = []
  let current = board
  let where = "board"

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    if (BOARD_HEADING.test(line)) {
      current = board
      where = "board"
      return
    }
    const block = BLOCK_HEADING.exec(line)
    if (block) {
      const name = block[1]
      current = blocks.get(name) ?? empty()
      blocks.set(name, current)
      where = `block ${name}`
      return
    }
    if (ANY_HEADING.test(line)) {
      // Other headings group the user's own notes; their text counts for the board.
      current = board
      where = "board"
      current.notes.push(line)
      return
    }
    const kv = KEY_LINE.exec(line)
    if (!kv) {
      current.notes.push(line)
      return
    }
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    if (key === "title") current.title = value || undefined
    else if (key === "function" || key === "purpose") current.function = value || undefined
    else {
      for (const token of value.split(/[\s,]+/).filter(Boolean)) {
        const m = PART_TOKEN.exec(token)
        if (!m) {
          errors.push(`line ${i + 1} (${where}): "${token}" is not +REFDES or -REFDES`)
          continue
        }
        if (where === "board") {
          errors.push(`line ${i + 1}: parts: only works under a block heading`)
          continue
        }
        ;(m[1] === "+" ? current.add : current.remove).push(m[2])
      }
    }
  })
  return { board, blocks, errors }
}

/** Find a block's corrections by name, case-insensitively. */
export function blockCorrection(c: Corrections, block: string): SectionCorrection | undefined {
  const want = block.toLowerCase()
  for (const [name, s] of c.blocks) if (name.toLowerCase() === want) return s
  return undefined
}

export function partMoves(c: Corrections): PartMoves[] {
  return [...c.blocks].filter(([, s]) => s.add.length || s.remove.length).map(([block, s]) => ({ block, add: s.add, remove: s.remove }))
}

export interface CorrectionInput {
  block?: string
  title?: string
  function?: string
  addParts?: string[]
  removeParts?: string[]
  note?: string
}

/**
 * Apply one correction to the file text: set title/function lines, merge part
 * moves into the section's parts: line, append the note. Lines it does not
 * own are left as they are. Creates the file or section when missing.
 */
export function editCorrections(text: string, input: CorrectionInput): string {
  const lines = text ? text.replace(/\s+$/, "").split(/\r?\n/) : []
  const isTarget = (line: string) => {
    const t = line.trim()
    if (!input.block) return BOARD_HEADING.test(t)
    const m = BLOCK_HEADING.exec(t)
    return !!m && m[1].toLowerCase() === input.block.toLowerCase()
  }

  let start = lines.findIndex(isTarget)
  if (start < 0) {
    const heading = input.block ? `## Block ${input.block}` : "# Board"
    if (input.block) {
      if (lines.length) lines.push("")
      lines.push(heading)
      start = lines.length - 1
    } else {
      // The board section goes first so it reads as the file's introduction.
      lines.unshift(heading, "")
      start = 0
    }
  }
  let end = lines.findIndex((l, i) => i > start && ANY_HEADING.test(l.trim()))
  if (end < 0) end = lines.length

  const section = lines.slice(start + 1, end)
  const setKey = (key: string, value: string | undefined) => {
    if (value === undefined) return
    const re = key === "function" ? /^\s*(function|purpose)\s*:/i : new RegExp(`^\\s*${key}\\s*:`, "i")
    const at = section.findIndex((l) => re.test(l))
    const line = `${key}: ${value.replace(/\s*\n\s*/g, " ").trim()}`
    if (at >= 0) section[at] = line
    else section.splice(firstContentIndex(section), 0, line)
  }
  setKey("title", input.title)
  setKey("function", input.function)

  if (input.addParts?.length || input.removeParts?.length) {
    const partLines = section.map((l, i) => (/^\s*parts\s*:/i.test(l) ? i : -1)).filter((i) => i >= 0)
    const tokens = new Map<string, "+" | "-">()
    for (const i of partLines) {
      for (const t of section[i].replace(/^\s*parts\s*:/i, "").split(/[\s,]+/).filter(Boolean)) {
        const m = PART_TOKEN.exec(t)
        if (m) tokens.set(m[2], m[1] as "+" | "-")
      }
    }
    for (const r of input.addParts ?? []) tokens.set(r, "+")
    for (const r of input.removeParts ?? []) tokens.set(r, "-")
    const line = `parts: ${[...tokens].map(([r, sign]) => sign + r).join(" ")}`
    if (partLines.length) {
      section[partLines[0]] = line
      for (const i of partLines.slice(1).reverse()) section.splice(i, 1)
    } else {
      section.splice(firstContentIndex(section), 0, line)
    }
  }

  if (input.note?.trim()) {
    while (section.length && !section[section.length - 1].trim()) section.pop()
    for (const l of input.note.trim().split(/\r?\n/)) section.push(l.trim() ? `- ${l.trim().replace(/^- /, "")}` : "")
  }
  // Keep one blank line before the next heading.
  while (section.length && !section[section.length - 1].trim()) section.pop()
  if (end < lines.length) section.push("")

  return [...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join("\n") + "\n"
}

/** Key lines go right below the heading, after other key lines. */
function firstContentIndex(section: string[]): number {
  let i = 0
  while (i < section.length && KEY_LINE.test(section[i].trim())) i++
  return i
}

export function writeCorrection(designsDir: string, stem: string, input: CorrectionInput): string {
  const path = correctionsPath(designsDir, stem)
  const text = existsSync(path) ? readFileSync(path, "utf8") : ""
  writeFileSync(path, editCorrections(text, input))
  return path
}
