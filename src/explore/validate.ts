// Deterministic checks of what the explore agents submit
// (docs/features/board-exploration.md). Errors reject the submit and go back
// to the agent as text; the agent fixes them and submits again.

import type { BoardIndex } from "../board.ts"
import { detectInterfaces, type Grouping } from "../overview.ts"
import { blockCorrection, type Corrections } from "./corrections.ts"
import type { BlockResult, BoardResult } from "./schema.ts"

export interface Checked<T> {
  /** Normalised result (canonical refdes, net and block names); undefined when rejected. */
  result?: T
  errors: string[]
  /** Accepted, but worth telling the agent. */
  notes: string[]
}

export function blockByName(g: Grouping, name: string): string | undefined {
  const want = name.trim().toLowerCase().replace(/^\/+|\/+$/g, "")
  return g.blocks.find((b) => b.name.toLowerCase() === want)?.name
}

function netName(board: BoardIndex, name: string): string | undefined {
  const nets = board.findNets(name)
  return nets.length === 1 ? nets[0].name : undefined
}

export function checkBlock(board: BoardIndex, g: Grouping, c: Corrections, input: BlockResult): Checked<BlockResult> {
  const errors: string[] = []
  const notes: string[] = []
  const name = blockByName(g, input.block)
  if (!name) {
    return { errors: [`No block named "${input.block}". Blocks: ${g.blocks.map((b) => b.name).join(", ")}`], notes }
  }
  const block = g.blocks.find((b) => b.name === name)!
  const members = new Set(block.members)
  const user = blockCorrection(c, name)
  const removed = new Set((user?.remove ?? []).map((r) => r.toUpperCase()))

  const keyParts: BlockResult["keyParts"] = []
  for (const k of input.keyParts) {
    const comp = board.findComponent(k.refdes)
    if (!comp) {
      errors.push(`keyParts: no component ${k.refdes}`)
      continue
    }
    if (removed.has(comp.refDes.toUpperCase())) {
      errors.push(`keyParts: the user removed ${comp.refDes} from ${name}`)
      continue
    }
    if (!members.has(comp.refDes)) {
      const actual = g.blockOf.get(comp.refDes)
      errors.push(`keyParts: ${comp.refDes} is not in ${name}${actual ? ` but in ${actual}` : ""}; describe it there or leave it out`)
      continue
    }
    keyParts.push({ refdes: comp.refDes, role: k.role })
  }

  const rails: string[] = []
  for (const r of input.rails) {
    const net = netName(board, r)
    if (net) rails.push(net)
    else errors.push(`rails: no unique net named ${r}`)
  }

  const interfaces = input.interfaces.map((i) => {
    if (!i.peer) return i
    const peer = blockByName(g, i.peer)
    if (!peer) {
      // Interfaces often leave the board through a connector; an unknown peer is noted, not rejected.
      notes.push(`interfaces: "${i.peer}" is not a block name; kept as text`)
      return i
    }
    return { ...i, peer }
  })

  if (user?.title || user?.function) {
    notes.push(`The user set ${[user.title && "title", user.function && "function"].filter(Boolean).join(" and ")} for ${name}; theirs is shown instead of yours.`)
  }
  if (errors.length) return { errors, notes }
  return { result: { ...input, block: name, keyParts, rails, interfaces }, errors, notes }
}

export function checkBoard(board: BoardIndex, g: Grouping, c: Corrections, input: BoardResult): Checked<BoardResult> {
  const errors: string[] = []
  const notes: string[] = []
  const buses = detectInterfaces(board)

  const dataFlow: BoardResult["dataFlow"] = []
  for (const e of input.dataFlow) {
    const from = blockByName(g, e.from)
    const to = blockByName(g, e.to)
    if (!from || !to) {
      errors.push(`dataFlow ${e.from} -> ${e.to}: ${[!from && e.from, !to && e.to].filter(Boolean).join(" and ")} is not a block`)
      continue
    }
    if (from === to) {
      errors.push(`dataFlow ${from} -> ${to}: both ends are the same block`)
      continue
    }
    const fromBlock = g.blocks.find((b) => b.name === from)!
    const direct = fromBlock.boundary.some((x) => x.blocks.includes(to))
    const viaBus = buses.some((bus) => {
      const ends = new Set(bus.endpoints.map((r) => g.blockOf.get(r)))
      return ends.has(from) && ends.has(to)
    })
    if (!direct && !viaBus) {
      errors.push(`dataFlow ${from} -> ${to}: no net or bus connects these blocks; check odb_block ${from}`)
      continue
    }
    dataFlow.push({ ...e, from, to })
  }

  if (c.board.title || c.board.function) {
    notes.push(`The user set the board ${[c.board.title && "title", c.board.function && "purpose"].filter(Boolean).join(" and ")}; theirs is shown instead of yours.`)
  }
  if (errors.length) return { errors, notes }
  return { result: { ...input, dataFlow }, errors, notes }
}

export function formatChecked(what: string, checked: Checked<unknown>): string {
  if (checked.errors.length) {
    return [`${what} rejected, nothing was saved. Fix these and submit again:`, ...checked.errors.map((e) => `- ${e}`), ...checked.notes.map((n) => `note: ${n}`)].join("\n")
  }
  return [`${what} saved.`, ...checked.notes.map((n) => `note: ${n}`)].join("\n")
}
