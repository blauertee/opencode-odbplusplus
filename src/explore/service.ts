// Board understanding for one design: the explore agents' cached results, the
// user's corrections and the schematic files, merged for reading and checked
// on writing (docs/features/board-exploration.md). Everything is read from
// disk on each call; the files are small and other sessions may write them.
// Submits are synchronous read-modify-write, so parallel block explorers in
// one OpenCode process cannot interleave and lose each other's entries.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BoardIndex } from "../board.ts"
import { CACHE_DIR } from "../cache.ts"
import type { DesignHandle } from "../mapping/service.ts"
import { groupBlocks, GROUPING_VERSION, type Grouping } from "../overview.ts"
import { blockCorrection, partMoves, readCorrections, writeCorrection, type CorrectionInput, type Corrections } from "./corrections.ts"
import { EXPLORE_PROMPT_VERSION } from "./prompts.ts"
import { findSchematics, schematicHash, type SchematicFile } from "./schematic.ts"
import { UNDERSTANDING_SCHEMA_VERSION, type BlockResult, type BoardResult, type EntryMeta, type UnderstandingFile } from "./schema.ts"
import { blockByName, checkBlock, checkBoard, formatChecked } from "./validate.ts"

export interface UnderstandingOptions {
  designsDir: string
  /** Where cache files go; the `understandingDir` option moves them into the project. */
  cacheDir?: string
  /** Extra schematic files or folders (option `schematic`). */
  schematics?: string[]
}

/** Everything a tool needs about one design's understanding, read fresh. */
export interface UnderstandingContext {
  h: DesignHandle
  corrections: Corrections
  grouping: Grouping
  schematics: SchematicFile[]
  schematicHash: string
  file: UnderstandingFile
  cachePath: string
}

export type EntryState = "current" | "stale" | "missing"

export interface EntryStatus {
  state: EntryState
  reasons: string[]
}

export class UnderstandingService {
  readonly cacheDir: string

  constructor(readonly opts: UnderstandingOptions) {
    this.cacheDir = opts.cacheDir ?? join(CACHE_DIR, "understanding")
  }

  /** Grouping with the user's part moves applied; what odb_overview and odb_block show. */
  grouping(board: BoardIndex): Grouping {
    return groupBlocks(board, partMoves(readCorrections(this.opts.designsDir, board.name)))
  }

  /** Block titles for the cheap tools: the user's, else the saved agent result's. */
  titles(h: DesignHandle): Map<string, string> {
    const ctx = this.context(h)
    const out = new Map<string, string>()
    for (const b of ctx.grouping.blocks) {
      const t = blockCorrection(ctx.corrections, b.name)?.title ?? ctx.file.blocks[b.name]?.result.title
      if (t) out.set(b.name, t)
    }
    return out
  }

  context(h: DesignHandle): UnderstandingContext {
    const corrections = readCorrections(this.opts.designsDir, h.stem)
    const schematics = findSchematics(this.opts.designsDir, h.stem, this.opts.schematics)
    const cachePath = join(this.cacheDir, `${h.fingerprint}.json`)
    return {
      h,
      corrections,
      grouping: groupBlocks(h.board, partMoves(corrections)),
      schematics,
      schematicHash: schematicHash(schematics),
      file: readFile(cachePath) ?? { schemaVersion: UNDERSTANDING_SCHEMA_VERSION, design: h.stem, fingerprint: h.fingerprint, blocks: {} },
      cachePath,
    }
  }

  blockStatus(ctx: UnderstandingContext, block: string): EntryStatus {
    const entry = ctx.file.blocks[block]
    const b = ctx.grouping.blocks.find((x) => x.name === block)
    if (!entry) return { state: "missing", reasons: [] }
    return staleness(entry.meta, ctx, b ? membersHash(b.members) : "")
  }

  boardStatus(ctx: UnderstandingContext): EntryStatus {
    if (!ctx.file.board) return { state: "missing", reasons: [] }
    return staleness(ctx.file.board.meta, ctx, boardHash(ctx.grouping))
  }

  submitBlock(h: DesignHandle, input: BlockResult, agent: string): string {
    const ctx = this.context(h)
    const checked = checkBlock(h.board, ctx.grouping, ctx.corrections, input)
    if (checked.result) {
      const block = ctx.grouping.blocks.find((b) => b.name === checked.result!.block)!
      ctx.file.blocks[block.name] = { result: checked.result, meta: this.meta(ctx, agent, membersHash(block.members)) }
      writeFile(ctx.cachePath, ctx.file)
    }
    return formatChecked(`Block ${checked.result?.block ?? input.block}`, checked)
  }

  submitBoard(h: DesignHandle, input: BoardResult, agent: string): string {
    const ctx = this.context(h)
    const checked = checkBoard(h.board, ctx.grouping, ctx.corrections, input)
    if (checked.result) {
      ctx.file.board = { result: checked.result, meta: this.meta(ctx, agent, boardHash(ctx.grouping)) }
      writeFile(ctx.cachePath, ctx.file)
    }
    const missing = ctx.grouping.blocks.filter((b) => !ctx.file.blocks[b.name]).map((b) => b.name)
    const out = formatChecked("Board understanding", checked)
    return checked.result && missing.length ? `${out}\nBlocks without a saved result: ${missing.join(", ")}` : out
  }

  /**
   * Record a user correction in <design>.understanding.md. Returns what was
   * written and anything in it that does not match the board data; the
   * correction is recorded either way, the user decides.
   */
  correct(h: DesignHandle, input: CorrectionInput): string {
    const ctx = this.context(h)
    const lines: string[] = []
    let block = input.block
    if (block) {
      const known = blockByName(ctx.grouping, block)
      if (known) block = known
      else if (!input.addParts?.length) lines.push(`warning: "${block}" is not a block yet; it becomes one only when parts are added to it.`)
    }
    for (const r of [...(input.addParts ?? []), ...(input.removeParts ?? [])]) {
      if (!h.board.findComponent(r)) lines.push(`warning: no component ${r} on this board; recorded anyway, ask the user.`)
    }
    if (!block && (input.addParts?.length || input.removeParts?.length)) {
      return "Part moves need a block. Nothing was written."
    }
    const path = writeCorrection(this.opts.designsDir, h.stem, { ...input, block })
    const after = this.context(h)
    lines.unshift(`Recorded in ${path} under ${block ? `block ${block}` : "Board"}.`)
    for (const e of after.corrections.errors) lines.push(`file problem: ${e}`)
    const affected = this.affected(after, block, [...(input.addParts ?? []), ...(input.removeParts ?? [])])
    if (affected.length) lines.push(`Cached results to rewrite: ${affected.join(", ")}`)
    return lines.join("\n")
  }

  /** Saved results a correction affects: the block itself, and whatever mentions it or the parts. */
  affected(ctx: UnderstandingContext, block: string | undefined, terms: string[]): string[] {
    const out = new Set<string>()
    if (block && ctx.file.blocks[block]) out.add(`block ${block}`)
    for (const hit of this.mentioning(ctx, [block, ...terms].filter((t): t is string => !!t))) out.add(hit)
    // A board-level correction always concerns the board result.
    if (!block && ctx.file.board) out.add("board")
    return [...out]
  }

  /** Saved results whose text mentions any of the terms (refdes, nets, words). */
  mentioning(ctx: UnderstandingContext, terms: string[]): string[] {
    const out: string[] = []
    for (const [name, e] of Object.entries(ctx.file.blocks)) if (mentions(e.result, terms)) out.push(`block ${name}`)
    if (ctx.file.board && mentions(ctx.file.board.result, terms)) out.push("board")
    return out
  }

  /** Drop the cached results of a design; the user's corrections file stays. */
  reset(h: DesignHandle) {
    rmSync(join(this.cacheDir, `${h.fingerprint}.json`), { force: true })
  }

  private meta(ctx: UnderstandingContext, agent: string, members: string): EntryMeta {
    return {
      createdAt: new Date().toISOString(),
      agent,
      promptVersion: EXPLORE_PROMPT_VERSION,
      groupingVersion: GROUPING_VERSION,
      schematicHash: ctx.schematicHash,
      membersHash: members,
    }
  }
}

/** Whether any of the words occurs in the result's text, as a whole word, case-insensitively. */
export function mentions(result: unknown, words: string[]): boolean {
  if (!words.length) return false
  const text = JSON.stringify(result)
  return words.some((w) => new RegExp(`(?:^|[^A-Za-z0-9_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_])`, "i").test(text))
}

function staleness(meta: EntryMeta, ctx: UnderstandingContext, members: string): EntryStatus {
  const reasons: string[] = []
  if (!members) reasons.push("block no longer exists")
  else if (meta.membersHash !== members) reasons.push("block members changed")
  if (meta.schematicHash !== ctx.schematicHash) reasons.push(ctx.schematicHash ? "schematic changed" : "schematic removed")
  if (meta.promptVersion !== EXPLORE_PROMPT_VERSION || meta.groupingVersion !== GROUPING_VERSION) reasons.push("plugin updated")
  return { state: reasons.length ? "stale" : "current", reasons }
}

export function membersHash(members: string[]): string {
  return createHash("sha256").update([...members].sort().join("\n")).digest("hex")
}

function boardHash(g: Grouping): string {
  return membersHash(g.blocks.map((b) => b.name))
}

function readFile(path: string): UnderstandingFile | undefined {
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as UnderstandingFile
    return f.schemaVersion === UNDERSTANDING_SCHEMA_VERSION ? f : undefined
  } catch {
    return undefined
  }
}

function writeFile(path: string, data: UnderstandingFile) {
  mkdirSync(join(path, ".."), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n")
  // rename is atomic, so a concurrent reader never sees half a file
  renameSync(tmp, path)
}
