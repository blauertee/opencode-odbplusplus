// Plain-text rendering of a design's understanding: user corrections first,
// then the agents' saved results, then what heuristics alone know.

import type { BoardIndex } from "../board.ts"
import type { Block } from "../overview.ts"
import { blockCorrection, type SectionCorrection } from "./corrections.ts"
import { FIX_RULE } from "./prompts.ts"
import type { EntryStatus, UnderstandingContext, UnderstandingService } from "./service.ts"

function stateLabel(s: EntryStatus): string {
  if (s.state === "current") return ""
  if (s.state === "missing") return " [not explored]"
  return ` [stale: ${s.reasons.join(", ")}]`
}

function userLines(c: SectionCorrection | undefined, indent = ""): string[] {
  if (!c) return []
  const out: string[] = []
  if (c.title) out.push(`${indent}title: ${c.title}`)
  if (c.function) out.push(`${indent}function: ${c.function}`)
  if (c.add.length || c.remove.length) out.push(`${indent}parts: ${[...c.add.map((r) => `+${r}`), ...c.remove.map((r) => `-${r}`)].join(" ")}`)
  for (const n of c.notes) out.push(`${indent}${n}`)
  return out
}

/** Title shown for a block: the user's, else the agent's, else none. */
export function blockTitle(ctx: UnderstandingContext, block: string): string | undefined {
  return blockCorrection(ctx.corrections, block)?.title ?? ctx.file.blocks[block]?.result.title
}

export function understandingSummary(svc: UnderstandingService, ctx: UnderstandingContext): string {
  const { corrections: c, file, grouping: g } = ctx
  const lines = [`# Understanding of ${ctx.h.stem}`]
  lines.push(...sources(ctx))

  const boardStatus = svc.boardStatus(ctx)
  const b = file.board?.result
  const title = c.board.title ?? b?.title
  lines.push("", `## Board${title ? `: ${title}` : ""}${stateLabel(boardStatus)}`)
  const user = userLines(c.board)
  if (user.length) lines.push("User:", ...user.map((l) => `  ${l}`))
  if (b) {
    lines.push(`purpose: ${c.board.function ?? b.purpose}`, b.summary, `power: ${b.power}`)
    if (b.dataFlow.length) {
      lines.push("data flow:")
      for (const e of b.dataFlow) lines.push(`  ${e.from} -> ${e.to} via ${e.via}${e.description ? `: ${e.description}` : ""}`)
    }
    if (b.openQuestions?.length) lines.push(`open questions: ${b.openQuestions.join("; ")}`)
    lines.push(`(${file.board!.meta.agent}, ${file.board!.meta.createdAt.slice(0, 10)}, confidence ${b.confidence})`)
  } else if (!user.length) {
    lines.push("Not explored yet. Launch the odb-explore subagent for a full picture.")
  }

  lines.push("", `## Blocks (${g.blocks.length}, grouped from ${g.detail})`)
  for (const block of g.blocks) lines.push(blockLine(svc, ctx, block))
  const orphans = Object.keys(file.blocks).filter((n) => !g.blocks.some((x) => x.name === n))
  if (orphans.length) lines.push(`Saved results for blocks that no longer exist: ${orphans.join(", ")}`)
  for (const name of c.blocks.keys()) {
    if (!g.blocks.some((x) => x.name.toLowerCase() === name.toLowerCase())) lines.push(`Corrections for unknown block "${name}" (add parts to create it).`)
  }

  lines.push("", FIX_RULE)
  return lines.join("\n")
}

function blockLine(svc: UnderstandingService, ctx: UnderstandingContext, block: Block): string {
  const entry = ctx.file.blocks[block.name]?.result
  const user = blockCorrection(ctx.corrections, block.name)
  const title = user?.title ?? entry?.title
  const fn = user?.function ?? entry?.function
  const marks = [user ? "user-corrected" : "", stateLabel(svc.blockStatus(ctx, block.name)).trim()].filter(Boolean).join(" ")
  return `- ${block.name}${title ? ` "${title}"` : ""}: ${fn ?? `${block.members.length} parts, key parts ${block.anchors.slice(0, 4).join(", ") || "none"}`}${marks ? ` ${marks}` : ""}`
}

export function understandingBlock(svc: UnderstandingService, ctx: UnderstandingContext, block: Block, board: BoardIndex): string {
  const entry = ctx.file.blocks[block.name]
  const user = blockCorrection(ctx.corrections, block.name)
  const lines = [`# Block ${block.name}${stateLabel(svc.blockStatus(ctx, block.name))}`, `${block.members.length} parts; details: odb_block ${block.name}`]
  lines.push(...sources(ctx))
  const u = userLines(user)
  if (u.length) lines.push("", "## User corrections (authoritative)", ...u)
  if (entry) {
    const r = entry.result
    lines.push("", `## Saved result (${entry.meta.agent}, ${entry.meta.createdAt.slice(0, 10)}, confidence ${r.confidence})`)
    lines.push(`title: ${r.title}`, `function: ${r.function}`)
    if (r.keyParts.length) {
      lines.push("key parts:")
      for (const k of r.keyParts) {
        const c = board.components.get(k.refdes)
        lines.push(`  ${k.refdes}${c ? ` ${board.value(c) ?? c.part ?? ""}`.trimEnd() : ""}: ${k.role}`)
      }
    }
    if (r.interfaces.length) {
      lines.push("interfaces:")
      for (const i of r.interfaces) lines.push(`  ${i.name}${i.direction ? ` (${i.direction})` : ""}${i.peer ? ` <-> ${i.peer}` : ""}${i.description ? `: ${i.description}` : ""}`)
    }
    if (r.rails.length) lines.push(`rails: ${r.rails.join(", ")}`)
    for (const n of r.notes ?? []) lines.push(`note: ${n}`)
    if (r.evidence.length) lines.push(`evidence: ${r.evidence.join("; ")}`)
    if (r.openQuestions?.length) lines.push(`open questions: ${r.openQuestions.join("; ")}`)
  } else {
    lines.push("", "Not explored yet. Launch odb-block-explore for this block.")
  }
  lines.push("", FIX_RULE)
  return lines.join("\n")
}

export function mentionsDetail(ctx: UnderstandingContext, hits: string[], query: string): string {
  if (!hits.length) return `No saved result mentions ${query}.`
  return [`Saved results mentioning ${query}:`, ...hits.map((h) => `- ${h}`)].join("\n")
}

function sources(ctx: UnderstandingContext): string[] {
  const out: string[] = []
  const c = ctx.corrections
  out.push(`corrections file: ${c.path}${c.exists ? "" : " (none yet)"}`)
  for (const e of c.errors) out.push(`  problem: ${e}`)
  if (ctx.schematics.length) {
    out.push("schematic files (read them with the tools this setup offers; text versions first):")
    for (const f of ctx.schematics) out.push(`  ${f.path} (${Math.ceil(f.size / 1024)} KiB${f.text ? ", text" : ""})`)
  } else {
    out.push("schematic files: none")
  }
  return out
}
