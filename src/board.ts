// In-memory connectivity index of one ODB++ design.
//
// OdbDesign (via native/libodbpp) gives us the product model (nets -> pin
// connections) and the component layer records (refdes -> properties). The questions an
// agent asks ("what is IC35 connected to", "what sits between IC10 and IC35")
// are graph queries, so we build the graph once per design and answer every
// tool call from memory.

import type { NativeBoard } from "./native.ts"

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

// Test points are recognised by convention: KiCad, Altium and Pulsonix all
// export them as one- or two-pad components with a TP refdes and/or a
// "TP"/"TestPoint" footprint or value (ODB++'s .test_point pad attribute is
// not exported by any of them we have seen).
const TEST_POINT_REFDES = /^TP\d/i
const TEST_POINT_NAME = /(?:^|[^a-z])(?:tp|test[ _-]?point)(?:[^a-z]|$)/i
const TEST_POINT_MAX_PINS = 2

export class BoardIndex {
  readonly components = new Map<string, BoardComponent>()
  readonly nets = new Map<string, BoardNet>()

  constructor(
    readonly name: string,
    /** Nets with more pins than this are treated as rails for path search. */
    readonly railFanout = 40,
  ) {}

  static build(board: NativeBoard, name = board.name): BoardIndex {
    const index = new BoardIndex(name)

    for (const c of board.components ?? []) {
      index.components.set(c.refDes, {
        refDes: c.refDes,
        part: c.part,
        package: c.package,
        side: c.side,
        x: c.x,
        y: c.y,
        pins: new Map(),
        properties: { ...c.props },
      })
    }

    for (const net of board.nets ?? []) {
      const pins: PinRef[] = []
      for (const [refDes, pin] of net.pins) {
        pins.push({ refDes, pin })
        let comp = index.components.get(refDes)
        if (!comp) {
          comp = { refDes, pins: new Map(), properties: {} }
          index.components.set(refDes, comp)
        }
        comp.pins.set(pin, net.name)
      }
      index.nets.set(net.name, { name: net.name, pins })
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

  // ----------------------------------------------------------- test points

  /**
   * Whether a component is a test point. With a pattern, only the refdes is
   * matched against it; otherwise TP<n> refdes or a TP/TestPoint footprint or
   * value on a part with at most two pins.
   */
  isTestPoint(c: BoardComponent, pattern?: RegExp): boolean {
    if (pattern) return pattern.test(c.refDes)
    if (c.pins.size > TEST_POINT_MAX_PINS) return false
    if (TEST_POINT_REFDES.test(c.refDes)) return true
    return [c.package, c.part, this.value(c)].some((s) => s && TEST_POINT_NAME.test(s))
  }

  /** All test points, optionally restricted to one net, in natural refdes order. */
  testPoints(opts: { net?: string; pattern?: RegExp } = {}): BoardComponent[] {
    const candidates = opts.net
      ? [...new Set((this.nets.get(opts.net)?.pins ?? []).map((p) => p.refDes))].map((r) => this.components.get(r)!)
      : [...this.components.values()]
    return candidates.filter((c) => c && this.isTestPoint(c, opts.pattern)).sort((a, b) => naturalCompare(a.refDes, b.refDes))
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
export function toRegex(query: string): RegExp {
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
