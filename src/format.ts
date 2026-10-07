// Plain-text renderers. Tool output goes straight into the model's context,
// so it is compact, line-oriented and free of JSON noise.

import { PROPERTY_FIELDS } from "./aliases.ts"
import { naturalCompare, NO_NET, type BoardComponent, type BoardIndex, type PathStep } from "./board.ts"
import type { ResolvedValue } from "./mapping/rules.ts"
import { ANCHOR_MIN_PINS, isGround, type Block, type Bus, type Grouping } from "./overview.ts"
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

// ------------------------------------------------------------ overview

const MAX_LISTED = 12

/** "U6 TPS65988DHRSHR (USB-PD controller...)" for block and bus listings. */
function partLabel(board: BoardIndex, ref: string, withDescription = false): string {
  const c = board.components.get(ref)
  if (!c) return ref
  const value = board.value(c) ?? c.part
  const desc = withDescription ? board.description(c) : undefined
  return [c.refDes, value, desc ? `(${desc.length > 60 ? `${desc.slice(0, 57)}...` : desc})` : ""].filter(Boolean).join(" ")
}

function listed(items: string[], max = MAX_LISTED): string {
  return items.length > max ? `${items.slice(0, max).join(", ")} +${items.length - max} more` : items.join(", ")
}

/** Counts per refdes prefix, e.g. "R 20, C 15, D 2". */
function prefixCounts(refs: string[]): string {
  const counts = new Map<string, number>()
  for (const r of refs) {
    const p = r.replace(/\d.*$/, "") || r
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0])).map(([p, n]) => `${p} ${n}`).join(", ")
}

export function overviewDetail(board: BoardIndex, g: Grouping, buses: Bus[]): string {
  const comps = [...board.components.values()]
  const connected = comps.filter((c) => !board.isMechanical(c))
  const sides = new Map<string, number>()
  for (const c of connected) sides.set(c.side ?? "?", (sides.get(c.side ?? "?") ?? 0) + 1)
  const placed = connected.filter((c) => c.x !== undefined && c.y !== undefined)
  const rails = [...board.nets.keys()].filter((n) => n !== NO_NET && board.isRail(n))
  const withValue = connected.filter((c) => board.value(c)).length
  const withDesc = connected.filter((c) => board.description(c)).length

  const lines = [`# ${board.name}`]
  lines.push(
    `${connected.length} parts (${[...sides].map(([s, n]) => `${n} ${s}`).join(", ")}), ` +
      `${comps.length - connected.length} mechanical; ${board.nets.size} nets, ${rails.length} of them rails`,
  )
  if (placed.length) {
    const xs = placed.map((c) => c.x!)
    const ys = placed.map((c) => c.y!)
    lines.push(`parts span ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} x ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)}`)
  }
  lines.push(`data: value on ${withValue}, description on ${withDesc} of ${connected.length} parts`)

  const byPlacement = (p: string) => [...g.placement.values()].filter((x) => x === p).length
  lines.push(
    "",
    `## Blocks (${g.blocks.length}), inferred from ${g.detail}`,
    `placed ${byPlacement("direct")} parts directly, ${byPlacement("connectivity")} by connectivity, ` +
      `${byPlacement("proximity")} by proximity; ${g.unassigned.length} unplaced. Details: odb_block.`,
  )
  const shownBlocks = g.blocks.slice(0, 25)
  for (const b of shownBlocks) {
    const key = b.anchors.slice(0, 4).map((r) => partLabel(board, r, true))
    const rails = b.rails.slice(0, 3).map((r) => r.net)
    lines.push(
      `- ${b.name}: ${b.members.length} parts` +
        (key.length ? ` | ${key.join("; ")}${b.anchors.length > 4 ? ` +${b.anchors.length - 4}` : ""}` : "") +
        (rails.length ? ` | rails ${rails.join(", ")}` : "") +
        ` | ${b.boundary.length} nets to other blocks`,
    )
  }
  if (g.blocks.length > shownBlocks.length) {
    const rest = g.blocks.slice(shownBlocks.length)
    lines.push(`- ${rest.length} smaller blocks with ${rest.reduce((n, b) => n + b.members.length, 0)} parts: ${listed(rest.map((b) => b.name))}`)
  }

  lines.push("", `## Interfaces (${buses.length}). Details: odb_interfaces.`)
  const kinds = new Map<string, Bus[]>()
  for (const b of buses) kinds.set(b.kind, [...(kinds.get(b.kind) ?? []), b])
  for (const [kind, list] of kinds) {
    const nets = list.reduce((n, b) => n + b.nets.length, 0)
    lines.push(`- ${kind}: ${list.length} buses, ${nets} nets: ${listed(list.map((b) => b.name), 8)}`)
  }

  const railPins = rails
    .filter((n) => !isGround(n))
    .map((n) => ({ n, pins: board.nets.get(n)!.pins.length }))
    .sort((a, b) => b.pins - a.pins)
  lines.push("", `## Supply rails (${railPins.length}, ground excluded)`)
  lines.push(listed(railPins.map((r) => `${r.n} (${r.pins})`), 20))
  return lines.join("\n")
}

export function blockDetail(board: BoardIndex, g: Grouping, b: Block): string {
  const how = new Map<string, number>()
  for (const r of b.members) {
    const p = g.placement.get(r) ?? "direct"
    how.set(p, (how.get(p) ?? 0) + 1)
  }
  const lines = [
    `# Block ${b.name} (${b.members.length} parts, from ${g.detail})`,
    `placement: ${(["direct", "connectivity", "proximity"] as const).filter((p) => how.has(p)).map((p) => `${how.get(p)} ${p}`).join(", ")}`,
    "",
    `## Key parts (${b.anchors.length}, >= ${ANCHOR_MIN_PINS} pins)`,
  ]
  for (const r of b.anchors) {
    const c = board.components.get(r)!
    lines.push(`${partLabel(board, r, true)} | ${c.pins.size} pins${c.side ? ` | ${c.side}` : ""}`)
  }
  const small = b.members.filter((r) => !b.anchors.includes(r))
  lines.push("", `## Other parts (${small.length}): ${prefixCounts(small)}`)
  // Small parts with a value are worth listing compactly; they say what the block does (crystals, LEDs, fuses).
  const valued = small
    .map((r) => board.components.get(r)!)
    .filter((c) => !/^[RC]\d/i.test(c.refDes))
    .map((c) => partLabel(board, c.refDes))
  if (valued.length) lines.push(listed(valued, 30))

  lines.push("", `## Supply rails (${b.rails.length})`, listed(b.rails.map((r) => `${r.net} (${r.parts} parts)`), 20))

  lines.push("", `## Nets to other blocks (${b.boundary.length})`)
  for (const x of b.boundary.slice(0, 60)) lines.push(`${x.net} -> ${x.blocks.join(", ")}`)
  if (b.boundary.length > 60) lines.push(`+${b.boundary.length - 60} more`)
  return lines.join("\n")
}

export function interfacesDetail(board: BoardIndex, buses: Bus[], g?: Grouping): string {
  const lines = [`# Interfaces (${buses.length}), recognised by net names`]
  let kind = ""
  for (const b of buses) {
    if (b.kind !== kind) {
      kind = b.kind
      lines.push("", `## ${kind}`)
    }
    const blocks = g ? [...new Set(b.endpoints.map((r) => g.blockOf.get(r)).filter(Boolean))] : []
    const head = `${b.name}: ${b.nets.length} nets${b.diffPairs ? `, ${b.diffPairs} diff pairs` : ""}`
    lines.push(`- ${head}${blocks.length ? ` | blocks ${blocks.join(", ")}` : ""}`)
    lines.push(`  nets: ${listed(b.nets, 8)}`)
    if (b.endpoints.length) lines.push(`  ends: ${listed(b.endpoints.map((r) => partLabel(board, r)), 6)}`)
    if (b.series.length) lines.push(`  in series: ${listed(b.series, 10)}`)
    if (b.pulls.length) lines.push(`  to rails (pull-ups, ESD, termination): ${listed(b.pulls, 10)}`)
  }
  return lines.join("\n")
}
