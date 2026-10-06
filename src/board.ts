// In-memory connectivity index of one ODB++ design.
//
// OdbDesignServer gives us the raw product model (nets -> pin connections)
// and the component layer files (refdes -> properties). The questions an
// agent asks ("what is IC35 connected to", "what sits between IC10 and IC35")
// are graph queries, so we build the graph once per design and answer every
// tool call from memory.

import type { ComponentRecord, Design } from "./client.ts"

export interface PinRef {
  refDes: string
  pin: string
}

export interface BoardComponent {
  refDes: string
  part?: string
  package?: string
  side?: string
  x?: number
  y?: number
  /** pin name -> net name */
  pins: Map<string, string>
  properties: Record<string, string>
}

export interface BoardNet {
  name: string
  pins: PinRef[]
}

export interface PathStep {
  refDes: string
  /** net leading to the next component; undefined for the last step */
  via?: string
}

export interface PathOptions {
  /** Intermediate components may have at most this many pins (endpoints are exempt). */
  maxPinsThrough?: number
  /** Give up beyond this many components per path. */
  maxDepth?: number
  /** Cap on enumerated shortest paths. */
  maxPaths?: number
  /** Traverse power/ground rails too (almost always produces noise). */
  includeRails?: boolean
}

/** ODB++ uses this pseudo-net for unconnected pins. */
export const NO_NET = "$NONE$"

const RAIL_NAME =
  /^(?:[+-]?\d+V\d*\w*|\d+V\d+\w*|A?GND\w*|D?GND\w*|P?GND\w*|VSS\w*|VCC\w*|VDD\w*|VEE\w*|VBUS\w*|VBAT\w*|VIN\w*|VSYS\w*)$/i

// Property names differ per EDA tool; first match wins.
const VALUE_KEYS = ["value", "val", "comment"]
const MPN_KEYS = ["mpn", "manufacturer part number", "manufacturer_part_number", "part number", "partnumber", "pn"]
const DATASHEET_KEYS = ["datasheet", "datasheet url", "datasheeturl", "componentlink1url", "help url"]
const DESCRIPTION_KEYS = ["description", "desc"]

export class BoardIndex {
  readonly components = new Map<string, BoardComponent>()
  readonly nets = new Map<string, BoardNet>()

  constructor(
    readonly name: string,
    /** Nets with more pins than this are treated as rails for path search. */
    readonly railFanout = 40,
  ) {}

  static build(name: string, design: Design, records: ComponentRecord[] = []): BoardIndex {
    const index = new BoardIndex(name)

    for (const c of design.components ?? []) {
      index.components.set(c.refDes, {
        refDes: c.refDes,
        part: c.partName,
        package: c.package?.name,
        side: c.side,
        pins: new Map(),
        properties: {},
      })
    }

    for (const net of design.nets ?? []) {
      const pins: PinRef[] = []
      for (const pc of net.pinConnections ?? []) {
        const refDes = pc.component?.refDes
        const pin = pc.pin?.name
        if (!refDes || pin === undefined) continue
        pins.push({ refDes, pin })
        let comp = index.components.get(refDes)
        if (!comp) {
          comp = { refDes, part: pc.component.partName, package: pc.component.package?.name, pins: new Map(), properties: {} }
          index.components.set(refDes, comp)
        }
        comp.pins.set(pin, net.name)
      }
      index.nets.set(net.name, { name: net.name, pins })
    }

    for (const r of records) {
      const comp = index.components.get(r.compName)
      if (!comp) continue
      comp.x = r.locationX
      comp.y = r.locationY
      for (const p of r.propertyRecords ?? []) comp.properties[p.name] = p.value ?? ""
    }

    return index
  }

  // ---------------------------------------------------------------- lookup

  findComponent(refDes: string): BoardComponent | undefined {
    const exact = this.components.get(refDes)
    if (exact) return exact
    const upper = refDes.toUpperCase()
    for (const c of this.components.values()) if (c.refDes.toUpperCase() === upper) return c
    return undefined
  }

  /**
   * Resolve a user-supplied net name. KiCad prefixes local nets with their
   * sheet path ("/CSI/CSI1_D0_N"), so a bare "CSI1_D0_N" matches by suffix.
   * Returns all candidates when the name is ambiguous.
   */
  findNets(name: string): BoardNet[] {
    const exact = this.nets.get(name)
    if (exact) return [exact]
    const upper = name.toUpperCase()
    const ci = [...this.nets.values()].filter((n) => n.name.toUpperCase() === upper)
    if (ci.length) return ci
    return [...this.nets.values()].filter((n) => n.name.toUpperCase().endsWith("/" + upper.replace(/^\/+/, "")))
  }

  isRail(netName: string): boolean {
    if (netName === NO_NET) return true
    const leaf = netName.split("/").pop() ?? netName
    if (RAIL_NAME.test(leaf)) return true
    return (this.nets.get(netName)?.pins.length ?? 0) > this.railFanout
  }

  // ------------------------------------------------------------ properties

  value(c: BoardComponent) {
    return prop(c, VALUE_KEYS)
  }
  mpn(c: BoardComponent) {
    return prop(c, MPN_KEYS)
  }
  datasheet(c: BoardComponent) {
    return prop(c, DATASHEET_KEYS)
  }
  description(c: BoardComponent) {
    return prop(c, DESCRIPTION_KEYS)
  }

  // --------------------------------------------------------------- queries

  /** Free-text search over refdes, value, MPN, description, part and net names. */
  search(query: string, limit = 50): { components: BoardComponent[]; nets: BoardNet[] } {
    const re = toRegex(query)
    const components = [...this.components.values()]
      .filter((c) =>
        [c.refDes, c.part, c.package, this.value(c), this.mpn(c), this.description(c)].some((s) => s && re.test(s)),
      )
      .sort((a, b) => naturalCompare(a.refDes, b.refDes))
      .slice(0, limit)
    const nets = [...this.nets.values()]
      .filter((n) => n.name !== NO_NET && re.test(n.name))
      .sort((a, b) => naturalCompare(a.name, b.name))
      .slice(0, limit)
    return { components, nets }
  }

  /**
   * Shortest component chains between two parts. Components are nodes; two
   * components are adjacent if they share a non-rail net. Intermediate nodes
   * must be "pass-through" sized (resistors, caps, ferrites, ESD diodes, ...)
   * unless maxPinsThrough is raised.
   */
  signalPaths(from: string, to: string, opts: PathOptions = {}): PathStep[][] {
    const maxPinsThrough = opts.maxPinsThrough ?? 4
    const maxDepth = opts.maxDepth ?? 8
    const maxPaths = opts.maxPaths ?? 10
    const src = this.findComponent(from)
    const dst = this.findComponent(to)
    if (!src || !dst) return []

    const usable = (net: string) => opts.includeRails || !this.isRail(net)
    const passable = (c: BoardComponent) => c.refDes === dst.refDes || c.pins.size <= maxPinsThrough

    // BFS recording every predecessor at shortest distance so all shortest
    // paths can be enumerated afterwards.
    const dist = new Map<string, number>([[src.refDes, 0]])
    const preds = new Map<string, { from: string; via: string }[]>()
    let frontier = [src.refDes]
    while (frontier.length && !dist.has(dst.refDes)) {
      const next: string[] = []
      const depth = dist.get(frontier[0])! + 1
      if (depth > maxDepth) break
      for (const ref of frontier) {
        const comp = this.components.get(ref)!
        if (ref !== src.refDes && !passable(comp)) continue
        for (const netName of new Set(comp.pins.values())) {
          if (!usable(netName)) continue
          for (const p of this.nets.get(netName)?.pins ?? []) {
            if (p.refDes === ref) continue
            const seen = dist.get(p.refDes)
            if (seen === undefined) {
              dist.set(p.refDes, depth)
              next.push(p.refDes)
            }
            if (seen === undefined || seen === depth) {
              const list = preds.get(p.refDes) ?? []
              if (!list.some((e) => e.from === ref && e.via === netName)) list.push({ from: ref, via: netName })
              preds.set(p.refDes, list)
            }
          }
        }
      }
      frontier = next
    }
    if (!dist.has(dst.refDes)) return []

    // Walk predecessors back from the destination, attaching the net of each hop.
    const paths: PathStep[][] = []
    const build = (ref: string, tail: PathStep[]) => {
      if (ref === src.refDes) {
        paths.push(tail)
        return
      }
      for (const e of preds.get(ref) ?? []) {
        if (paths.length >= maxPaths) return
        build(e.from, [{ refDes: e.from, via: e.via }, ...tail])
      }
    }
    build(dst.refDes, [{ refDes: dst.refDes }])
    return paths
  }
}

function prop(c: BoardComponent, keys: string[]): string | undefined {
  for (const key of keys) {
    for (const [k, v] of Object.entries(c.properties)) {
      if (k.toLowerCase() === key && v && v !== "~") return v
    }
  }
  return undefined
}

/** Treat the query as a regex when it looks like one, else as a case-insensitive substring. */
function toRegex(query: string): RegExp {
  try {
    if (/[\^$*+?()[\]{}|\\]/.test(query)) return new RegExp(query, "i")
  } catch {
    // fall through to literal match
  }
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}
