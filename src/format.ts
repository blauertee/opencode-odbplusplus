// Plain-text renderers. Tool output goes straight into the model's context,
// so it is compact, line-oriented and free of JSON noise.

import { PROPERTY_FIELDS } from "./aliases.ts"
import { naturalCompare, NO_NET, type BoardComponent, type BoardIndex, type PathStep } from "./board.ts"
import type { ResolvedValue } from "./mapping/rules.ts"
import type { MappingRule } from "./mapping/schema.ts"
import type { DesignHandle } from "./mapping/service.ts"

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
  const value = board.resolve(c, "value")[0]
  const mpn = board.resolve(c, "mpn")[0]
  const ds = board.datasheet(c)
  const desc = board.description(c)
  const mfr = board.manufacturer(c)
  if (value) lines.push(`value: ${value.value}${provenance(value)}`)
  if (mpn) lines.push(`mpn: ${mpn.value}${provenance(mpn)}`)
  if (mfr) lines.push(`manufacturer: ${mfr}`)
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

/** Where a value came from, when it is not a plain property. */
function provenance(r: ResolvedValue): string {
  const bits: string[] = []
  if (r.inferred) bits.push(r.source === "part name" ? "inferred from part name" : "inferred")
  else if (!r.source.startsWith("property ")) bits.push(`from ${r.source}`)
  if (r.verified === true) bits.push("verified")
  if (r.verified === false) bits.push("unverified")
  return bits.length ? ` (${bits.join(", ")})` : ""
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

/** One line per test point: refdes, net(s), side and position for probing. */
export function testPointLine(c: BoardComponent): string {
  const nets = [...new Set(c.pins.values())].map((n) => (n === NO_NET ? "(unconnected)" : n))
  const bits = [c.refDes, nets.join(", ") || "(no pins)"]
  if (c.side) bits.push(c.side)
  if (c.x !== undefined && c.y !== undefined) bits.push(`at ${c.x}, ${c.y}`)
  return bits.join(" | ")
}

export function testPointsDetail(heading: string, tps: BoardComponent[]): string {
  return [`# ${heading} (${tps.length})`, ...tps.map(testPointLine)].join("\n")
}

/** odb_mapping output: coverage, gaps, rules in use and the last agent run. */
export function mappingStatus(h: DesignHandle): string {
  const { board, health } = h
  const lines = [`# Property mapping of ${board.name}`, `${health.eligible.length} of ${board.components.size} components counted (connected, not mechanical)`, ""]
  lines.push("## Coverage")
  for (const f of PROPERTY_FIELDS) {
    const c = health.coverage[f]
    const sources = Object.entries(c.sources).map(([s, n]) => `${s} ${n}`).join(", ")
    lines.push(`${f}: ${c.mapped} of ${c.of}${f === "mpn" ? " non-passive" : ""}${sources ? ` (${sources})` : ""}`)
  }
  lines.push(`test points: ${health.testPoints}`)
  lines.push("", `## Gaps (${health.gaps.length})${health.launch ? ", agent run warranted" : ""}`)
  for (const g of health.gaps) lines.push(`${g.signal} ${g.strength} ${g.target}: ${g.summary}`)

  if (h.overlay) {
    const o = h.overlay
    lines.push("", `## Agent mapping (${o.createdAt}, ${o.output.rules.length} rules, ${o.rejected} rejected)`, o.output.summary)
    for (const r of o.output.rules) lines.push(`- ${ruleLine(r)}`)
    for (const u of o.output.unresolved) lines.push(`- unresolved ${u.target}: ${u.detail}${u.suggestion ? ` ${u.suggestion}` : ""}`)
  }
  if (h.user) {
    lines.push("", `## User overrides (${h.user.path}, ${h.user.rules.length} rules)`)
    for (const r of h.user.rules) lines.push(`- ${ruleLine(r)}`)
    for (const e of h.user.errors) lines.push(`- invalid: ${e}`)
  }
  if (h.run) lines.push("", "A mapping repair is running.")
  if (h.lastRun) lines.push("", h.lastRun)
  return lines.join("\n")
}

function ruleLine(r: MappingRule): string {
  switch (r.kind) {
    case "propertyAlias":
      return `property "${r.property}" -> ${r.field}${r.scope?.refdesPrefixes?.length ? ` for ${r.scope.refdesPrefixes.join(", ")}` : ""}`
    case "ignoreProperty":
      return `ignore property "${r.property}" (${r.reason})`
    case "partNameAs":
      return `part name -> ${r.field} for ${[...(r.scope.refdesPrefixes ?? []), ...(r.scope.refdes ?? [])].slice(0, 12).join(", ")}`
    case "componentValue":
      return `${r.refDes} ${r.field} = ${r.value} (${r.source.kind})`
    case "classify":
      return `${r.feature} = ${r.value} for ${JSON.stringify(r.match)}`
    case "rail":
      return `rail = ${r.value}: ${r.nets.join(", ")}`
  }
}
