// Plain-text renderers. Tool output goes straight into the model's context,
// so it is compact, line-oriented and free of JSON noise.

import { naturalCompare, NO_NET, type BoardComponent, type BoardIndex, type PathStep } from "./board.ts"

export function componentSummary(board: BoardIndex, c: BoardComponent): string {
  const bits = [c.refDes]
  const value = board.value(c)
  const mpn = board.mpn(c)
  if (value) bits.push(value)
  if (mpn && mpn !== value) bits.push(`MPN ${mpn}`)
  if (c.package) bits.push(`pkg ${c.package}`)
  return bits.join(" | ")
}

export function componentDetail(board: BoardIndex, c: BoardComponent, neighbourLimit: number): string {
  const lines: string[] = []
  lines.push(`# ${c.refDes}`)
  const value = board.value(c)
  const mpn = board.mpn(c)
  const ds = board.datasheet(c)
  const desc = board.description(c)
  if (value) lines.push(`value: ${value}`)
  if (mpn) lines.push(`mpn: ${mpn}`)
  if (desc) lines.push(`description: ${desc}`)
  if (c.package) lines.push(`package: ${c.package}`)
  if (c.side) lines.push(`side: ${c.side}`)
  if (c.x !== undefined && c.y !== undefined) lines.push(`position: ${c.x}, ${c.y}`)
  if (ds) lines.push(`datasheet: ${ds}`)
  lines.push("")
  lines.push(`## Pins (${c.pins.size})`)

  const pins = [...c.pins.entries()].sort(([a], [b]) => naturalCompare(a, b))
  for (const [pin, net] of pins) {
    if (net === NO_NET) {
      lines.push(`${pin}: (unconnected)`)
      continue
    }
    const others = (board.nets.get(net)?.pins ?? []).filter((p) => p.refDes !== c.refDes)
    if (board.isRail(net)) {
      lines.push(`${pin}: ${net} [rail, ${others.length} other pins]`)
      continue
    }
    const shown = others.slice(0, neighbourLimit).map((p) => `${p.refDes}.${p.pin}`)
    const more = others.length > neighbourLimit ? ` +${others.length - neighbourLimit} more` : ""
    lines.push(`${pin}: ${net} -> ${shown.join(", ") || "(no other pins)"}${more}`)
  }
  return lines.join("\n")
}

export function netDetail(board: BoardIndex, netName: string): string {
  const net = board.nets.get(netName)
  if (!net) return `Net ${netName} not found`
  const byComp = new Map<string, string[]>()
  for (const p of net.pins) byComp.set(p.refDes, [...(byComp.get(p.refDes) ?? []), p.pin])
  const lines = [`# Net ${net.name}`, `${net.pins.length} pins on ${byComp.size} components${board.isRail(net.name) ? " (rail)" : ""}`, ""]
  for (const ref of [...byComp.keys()].sort(naturalCompare)) {
    const c = board.components.get(ref)
    const pins = byComp.get(ref)!.sort(naturalCompare).join(",")
    lines.push(`${c ? componentSummary(board, c) : ref} | pins ${pins}`)
  }
  return lines.join("\n")
}

export function pathsDetail(board: BoardIndex, paths: PathStep[][]): string {
  const lines: string[] = []
  const between = new Set<string>()
  paths.forEach((path, i) => {
    const hops = path.map((s) => (s.via ? `${s.refDes} -[${s.via}]-> ` : s.refDes)).join("")
    lines.push(`${i + 1}. ${hops}`)
    for (const s of path.slice(1, -1)) between.add(s.refDes)
  })
  if (between.size) {
    lines.push("", "## Components on the chain")
    for (const ref of [...between].sort(naturalCompare)) {
      const c = board.components.get(ref)
      lines.push(c ? componentSummary(board, c) : ref)
    }
  }
  return lines.join("\n")
}
