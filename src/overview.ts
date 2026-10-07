// Bird's-eye structure of a design: functional blocks and interface buses.
//
// ODB++ carries no schematic structure (no sheets, hierarchy or net classes),
// and none of the exports we have use its attributes for it. The structure is
// inferred from what does survive the export:
//   - KiCad prefixes local nets with their sheet path ("/USB3/USB_SS_TX_P"),
//   - Altium-style per-sheet annotation numbers parts by sheet (R7012, C5101),
//   - connectivity: small parts belong to the IC or connector they serve,
//   - placement: decoupling caps sit next to the part they decouple.
// Interfaces come from net-name conventions (I2C, SPI, USB, ...).

import { naturalCompare, NO_NET, type BoardComponent, type BoardIndex } from "./board.ts"

/** Parts with at least this many pins anchor a block (ICs, connectors, modules). */
export const ANCHOR_MIN_PINS = 8
/** Max distance (board units, usually mm) for placing a rail-only part next to an anchor. */
const PROXIMITY_MAX = 15
const PROPAGATION_ROUNDS = 6

const GROUND = /(?:^|[^A-Z0-9])(?:[ADPS]?GND\w*|VSS\w*|0V)(?:[^A-Z0-9]|$)/i

export type GroupingSource = "sheet" | "refdesBand" | "cluster"
/** How a part got into its block. */
export type Placement = "direct" | "connectivity" | "proximity" | "user"

/** Bumped when grouping results change; cached block understanding keyed on it goes stale. */
export const GROUPING_VERSION = 1

/** A user's part moves for one block (from <design>.understanding.md). */
export interface PartMoves {
  block: string
  add: string[]
  remove: string[]
}

export interface Block {
  name: string
  members: string[]
  /** Members with >= ANCHOR_MIN_PINS pins, most pins first. */
  anchors: string[]
  /** Non-ground rails touched by members, most used first. */
  rails: { net: string; parts: number }[]
  /** Signal nets shared with other blocks, with the blocks on the other side. */
  boundary: { net: string; blocks: string[] }[]
}

export interface Grouping {
  source: GroupingSource
  /** Human-readable explanation of the source. */
  detail: string
  blocks: Block[]
  /** refDes -> block name */
  blockOf: Map<string, string>
  placement: Map<string, Placement>
  /** Connected parts no heuristic could place. */
  unassigned: string[]
}

export function isGround(net: string): boolean {
  return GROUND.test(net.split("/").pop() ?? net)
}

/** Parts that take part in grouping: connected and not mechanical. */
function groupable(board: BoardIndex): BoardComponent[] {
  return [...board.components.values()].filter((c) => !board.isMechanical(c))
}

// Resistor/capacitor arrays and LED bars have many pins but serve other parts.
const PASSIVE_REFDES = /^(?:R|RN|RA|RP|C|CN|CA|L|FB|LED|TP)\d/i

function isAnchor(board: BoardIndex, c: BoardComponent): boolean {
  return c.pins.size >= ANCHOR_MIN_PINS && !PASSIVE_REFDES.test(c.refDes) && !board.isTestPoint(c)
}

function signalNets(board: BoardIndex, c: BoardComponent): string[] {
  return [...new Set(c.pins.values())].filter((n) => n !== NO_NET && !board.isRail(n))
}

/**
 * Nets that tie a part to its neighbours for grouping: signal nets, plus nets
 * local to one schematic sheet even when their name looks like a rail
 * ("/Supply/5V_SW", "/Supply/3V3_FB" are a converter's own nodes).
 */
function groupingNets(board: BoardIndex, c: BoardComponent): string[] {
  return [...new Set(c.pins.values())].filter(
    (n) =>
      n !== NO_NET &&
      (!board.isRail(n) || (sheetOf(n) !== undefined && !isGround(n) && (board.nets.get(n)?.pins.length ?? 0) <= board.railFanout)),
  )
}

function railNets(board: BoardIndex, c: BoardComponent): string[] {
  return [...new Set(c.pins.values())].filter((n) => n !== NO_NET && board.isRail(n))
}

function top<K>(votes: Map<K, number>): K | undefined {
  let best: K | undefined
  let n = 0
  for (const [k, v] of votes) if (v > n) [best, n] = [k, v]
  return best
}

// ------------------------------------------------------------------ sources

/** Sheet path of a KiCad hierarchical net name ("/USB3/X" -> "USB3"), else undefined. */
export function sheetOf(net: string): string | undefined {
  if (!net.startsWith("/")) return undefined
  const parts = net.split("/").filter(Boolean)
  return parts.length >= 2 ? parts.slice(0, -1).join("/") : undefined
}

function sheetSeeds(board: BoardIndex, parts: BoardComponent[]): Map<string, string> | undefined {
  const seeds = new Map<string, string>()
  const sheets = new Set<string>()
  for (const c of parts) {
    const votes = new Map<string, number>()
    for (const n of groupingNets(board, c)) {
      const s = sheetOf(n)
      if (s) votes.set(s, (votes.get(s) ?? 0) + 1)
    }
    const s = top(votes)
    if (s) {
      seeds.set(c.refDes, s)
      sheets.add(s)
    }
  }
  return sheets.size >= 2 && seeds.size >= parts.length * 0.15 ? seeds : undefined
}

const REFDES_NUMBER = /^[A-Z$_-]*?(\d+)$/i

/**
 * Per-sheet annotation (Altium "by sheet number", common in other tools) gives
 * refdes like R7012: number / 1000 is the sheet. Detected when most numbered
 * parts sit at or above the band size and there are several bands.
 */
function refdesBandSeeds(parts: BoardComponent[]): { seeds: Map<string, string>; size: number } | undefined {
  const numbered = parts
    .map((c) => ({ c, n: Number(REFDES_NUMBER.exec(c.refDes)?.[1]) }))
    .filter((x) => Number.isFinite(x.n))
  if (numbered.length < 20) return undefined
  for (const size of [1000, 100]) {
    const banded = numbered.filter((x) => x.n >= size)
    const bands = new Set(banded.map((x) => Math.floor(x.n / size)))
    // Plain sequential numbering also exceeds 100 on big boards; require that
    // the bands are well filled and that each band restarts its counter.
    if (banded.length < numbered.length * 0.8 || bands.size < 2 || bands.size > 60) continue
    const restarts = [...bands].filter((b) => banded.some((x) => Math.floor(x.n / size) === b && x.n % size < 20))
    if (restarts.length < bands.size * 0.7) continue
    const seeds = new Map<string, string>()
    for (const x of banded) seeds.set(x.c.refDes, bandName(Math.floor(x.n / size), size))
    return { seeds, size }
  }
  return undefined
}

function bandName(band: number, size: number): string {
  return `${band}${"x".repeat(String(size).length - 1)}`
}

// ---------------------------------------------------------------- grouping

export function groupBlocks(board: BoardIndex, moves: PartMoves[] = []): Grouping {
  const parts = groupable(board)
  const byRef = new Map(parts.map((c) => [c.refDes, c]))
  const blockOf = new Map<string, string>()
  const placement = new Map<string, Placement>()

  let source: GroupingSource
  let detail: string
  const sheets = sheetSeeds(board, parts)
  const bands = sheets ? undefined : refdesBandSeeds(parts)
  if (sheets) {
    source = "sheet"
    detail = "schematic sheet names in hierarchical net names"
    for (const [r, s] of sheets) blockOf.set(r, s)
  } else if (bands) {
    source = "refdesBand"
    detail = `per-sheet refdes numbering (blocks of ${bands.size}, e.g. R7012 -> ${bandName(7, bands.size)})`
    for (const [r, s] of bands.seeds) blockOf.set(r, s)
  } else {
    source = "cluster"
    detail = `connectivity around parts with >= ${ANCHOR_MIN_PINS} pins`
    for (const c of parts) if (isAnchor(board, c)) blockOf.set(c.refDes, c.refDes)
  }
  for (const r of blockOf.keys()) placement.set(r, "direct")

  // Unplaced parts join the block their signal-net neighbours belong to.
  // Anchors count triple so a series resistor between two blocks goes to the IC side.
  for (let round = 0; round < PROPAGATION_ROUNDS; round++) {
    const next = new Map<string, string>()
    for (const c of parts) {
      if (blockOf.has(c.refDes)) continue
      const votes = new Map<string, number>()
      for (const n of groupingNets(board, c)) {
        for (const p of board.nets.get(n)?.pins ?? []) {
          const b = blockOf.get(p.refDes)
          if (!b || p.refDes === c.refDes) continue
          const other = byRef.get(p.refDes)
          votes.set(b, (votes.get(b) ?? 0) + (other && isAnchor(board, other) ? 3 : 1))
        }
      }
      const b = top(votes)
      if (b) next.set(c.refDes, b)
    }
    if (!next.size) break
    for (const [r, b] of next) {
      blockOf.set(r, b)
      placement.set(r, "connectivity")
    }
  }

  // Parts only on rails (decoupling, bulk caps): nearest placed anchor sharing a supply rail.
  const anchors = parts.filter((c) => isAnchor(board, c) && blockOf.has(c.refDes) && c.x !== undefined)
  for (const c of parts) {
    if (blockOf.has(c.refDes) || c.x === undefined || c.y === undefined) continue
    const supplies = railNets(board, c).filter((n) => !isGround(n))
    let best: { d: number; ref: string } | undefined
    for (const a of anchors) {
      const shares = supplies.length ? supplies.some((n) => [...a.pins.values()].includes(n)) : true
      if (!shares) continue
      const d = Math.hypot(a.x! - c.x, a.y! - c.y)
      if (d <= PROXIMITY_MAX && (!best || d < best.d)) best = { d, ref: a.refDes }
    }
    if (best) {
      blockOf.set(c.refDes, blockOf.get(best.ref)!)
      placement.set(c.refDes, "proximity")
    }
  }

  // User part moves win over every heuristic. Unknown refdes are skipped here and reported by odb_understanding.
  for (const m of moves) {
    for (const r of m.remove) {
      const ref = board.findComponent(r)?.refDes
      if (ref && blockOf.get(ref) === m.block) {
        blockOf.delete(ref)
        placement.set(ref, "user")
      }
    }
    for (const r of m.add) {
      const c = board.findComponent(r)
      if (!c) continue
      byRef.set(c.refDes, c)
      blockOf.set(c.refDes, m.block)
      placement.set(c.refDes, "user")
    }
  }

  const unassigned = parts.filter((c) => !blockOf.has(c.refDes)).map((c) => c.refDes).sort(naturalCompare)
  return { source, detail, blocks: describeBlocks(board, blockOf, byRef), blockOf, placement, unassigned }
}

function describeBlocks(board: BoardIndex, blockOf: Map<string, string>, byRef: Map<string, BoardComponent>): Block[] {
  const members = new Map<string, string[]>()
  for (const [r, b] of blockOf) members.set(b, [...(members.get(b) ?? []), r])

  const blocks: Block[] = []
  for (const [name, refs] of members) {
    refs.sort(naturalCompare)
    const comps = refs.map((r) => byRef.get(r)!)
    const anchors = comps
      .filter((c) => isAnchor(board, c))
      .sort((a, b) => b.pins.size - a.pins.size || naturalCompare(a.refDes, b.refDes))
      .map((c) => c.refDes)

    const railUse = new Map<string, number>()
    const signal = new Set<string>()
    for (const c of comps) {
      for (const n of railNets(board, c)) if (!isGround(n)) railUse.set(n, (railUse.get(n) ?? 0) + 1)
      for (const n of signalNets(board, c)) signal.add(n)
    }
    const rails = [...railUse].map(([net, parts]) => ({ net, parts })).sort((a, b) => b.parts - a.parts || naturalCompare(a.net, b.net))

    const boundary: Block["boundary"] = []
    for (const n of signal) {
      const others = new Set<string>()
      for (const p of board.nets.get(n)?.pins ?? []) {
        const b = blockOf.get(p.refDes)
        if (b && b !== name) others.add(b)
      }
      if (others.size) boundary.push({ net: n, blocks: [...others].sort(naturalCompare) })
    }
    boundary.sort((a, b) => naturalCompare(a.net, b.net))
    blocks.push({ name, members: refs, anchors, rails, boundary })
  }
  return blocks.sort((a, b) => b.members.length - a.members.length || naturalCompare(a.name, b.name))
}

/** Find a block by name, case-insensitively, or by a member refdes. */
export function findBlock(g: Grouping, query: string): Block | undefined {
  const q = query.toLowerCase().replace(/^\/+|\/+$/g, "")
  const byName = g.blocks.find((b) => b.name.toLowerCase() === q)
  if (byName) return byName
  for (const [r, b] of g.blockOf) if (r.toLowerCase() === q) return g.blocks.find((x) => x.name === b)
  return g.blocks.find((b) => b.name.toLowerCase().includes(q))
}

// --------------------------------------------------------------- interfaces

export interface Bus {
  kind: string
  /** Common name stem of the nets, e.g. "CSI0" or "GPIOEX_I2C". */
  name: string
  nets: string[]
  diffPairs: number
  /** Anchors reached directly or through one small part (series R, ESD, level shifter pins excluded). */
  endpoints: string[]
  /** Small parts in series on the bus (both pins on bus or bus-adjacent signal nets). */
  series: string[]
  /** Small parts tying a bus net to a rail (pull-ups/-downs, termination, ESD). */
  pulls: string[]
}

// A name token that names a bus ("I2C1", "CSI0", "USBC1") -> interface kind.
const BUS_TOKENS: [string, RegExp][] = [
  ["MIPI CSI/DSI", /^(?:CSI|DSI)\d*$/],
  ["HDMI", /^HDMI\d*$/],
  ["DisplayPort", /^(?:DP|EDP)\d+$/],
  ["PCIe", /^(?:PCIE|PEX)\d*$/],
  ["USB", /^USB/],
  ["Ethernet", /^(?:ETH\d*|GBE|MDI\d*|RGMII|RMII|SGMII)$/],
  ["SD/eMMC", /^(?:SDIO|SDMMC|EMMC|SDCARD)\d*$/],
  ["JTAG/SWD", /^(?:JTAG|SWD)$/],
  ["I2S/audio", /^(?:I2S|SAI|TDM)\d*$/],
  ["CAN", /^(?:F?D?CAN)\d*$/],
  ["I2C", /^(?:I2C|IIC|SMB|SMBUS|TWI)\d*$/],
  ["SPI", /^Q?SPI\d*$/],
  ["UART", /^U?S?ART\d*$|^UART\d*$|^DEBUG_?UART\d*$/],
]

// A signal-role token that implies the kind even without a bus name ("SYS_SCL").
const ROLE_TOKENS: [string, RegExp][] = [
  ["HDMI", /^(?:TMDS|CEC|DDC)$/],
  ["DisplayPort", /^HPD\d*$/],
  ["PCIe", /^(?:PERST|CLKREQ|REFCLK)\d*$/],
  ["USB", /^(?:CC[12]|SBU[12]|VBUS_?DET)$/],
  ["Ethernet", /^(?:MDIO|MDC)$/],
  ["JTAG/SWD", /^(?:TCK|TMS|TDI|TDO|SWDIO|SWCLK|SWO)$/],
  ["I2S/audio", /^(?:LRCLK|LRCK|BCLK|MCLK)$/],
  ["I2C", /^(?:SDA|SCL)\d*$/],
  ["SPI", /^(?:MOSI|MISO|SCK|COPI|CIPO)\d*$/],
  ["UART", /^(?:TXD|RXD|RTS|CTS)\d*$/],
]

/** Names the EDA tool made up for an unnamed net; they carry pad names, not functions. */
const AUTO_NET = /^(?:unconnected[-_(]|Net[-_]?\(|Net[A-Z$]+\d+_)/i

const SUPPLY_TOKEN = /^(?:VCC|VDD|VIN|VOUT|PWR|POWER|GND|\d+V\d*)$/

function netTokens(leaf: string): string[] {
  return leaf
    .replace(/\{slash\}/g, "/")
    .replace(/~\{([^}]*)\}/g, "$1")
    .replace(/[!~{}]/g, "")
    .toUpperCase()
    .split(/[_./\s-]+/)
    .filter(Boolean)
}

/**
 * Interface kind and bus name of a net, e.g. "CSI0_D0_N" -> MIPI CSI/DSI "CSI0",
 * "GPIOEX_I2C_SCL" -> I2C "GPIOEX_I2C", "SYS_SCL" -> I2C "SYS".
 */
export function classifyBusNet(leaf: string): { kind: string; name: string } | undefined {
  if (AUTO_NET.test(leaf)) return undefined
  const tokens = netTokens(leaf)
  // "CSIA_I2C_VCC" supplies a bus, it is not part of it.
  if (SUPPLY_TOKEN.test(tokens[tokens.length - 1] ?? "")) return undefined
  for (let i = 0; i < tokens.length; i++) {
    const bus = BUS_TOKENS.find(([, re]) => re.test(tokens[i]))
    if (bus) return { kind: bus[0], name: tokens.slice(0, i + 1).join("_") }
  }
  for (let i = 0; i < tokens.length; i++) {
    const role = ROLE_TOKENS.find(([, re]) => re.test(tokens[i]))
    if (role) return { kind: role[0], name: i ? tokens.slice(0, i).join("_") : role[0] }
  }
  return undefined
}

const DIFF_SUFFIX = /(?:_P|\+|_DP)$/i

export function detectInterfaces(board: BoardIndex): Bus[] {
  const groups = new Map<string, { kind: string; name: string; nets: string[] }>()
  for (const net of board.nets.keys()) {
    if (net === NO_NET || board.isRail(net)) continue
    if ((board.nets.get(net)?.pins.length ?? 0) < 2) continue
    const bus = classifyBusNet(net.split("/").pop() ?? net)
    if (!bus) continue
    const { kind, name } = bus
    const key = `${kind}\u0000${name}`
    const g = groups.get(key) ?? { kind, name, nets: [] }
    g.nets.push(net)
    groups.set(key, g)
  }

  const buses: Bus[] = []
  for (const g of groups.values()) {
    g.nets.sort(naturalCompare)
    const netSet = new Set(g.nets)
    const leaves = new Set(g.nets.map((n) => (n.split("/").pop() ?? n).toUpperCase()))
    let diffPairs = 0
    for (const l of leaves) {
      if (!DIFF_SUFFIX.test(l)) continue
      const neg = l.replace(/_P$/, "_N").replace(/\+$/, "-").replace(/_DP$/, "_DN")
      if (leaves.has(neg)) diffPairs++
    }

    const endpoints = new Set<string>()
    const series = new Set<string>()
    const pulls = new Set<string>()
    for (const n of g.nets) {
      for (const p of board.nets.get(n)?.pins ?? []) {
        const c = board.components.get(p.refDes)
        if (!c || board.isTestPoint(c)) continue
        if (isAnchor(board, c)) {
          endpoints.add(c.refDes)
          continue
        }
        const others = [...new Set(c.pins.values())].filter((x) => x !== n && x !== NO_NET)
        if (others.some((x) => board.isRail(x)) && !others.some((x) => !board.isRail(x))) {
          pulls.add(c.refDes)
          continue
        }
        // Series part: look one hop further for the anchor on the other side.
        series.add(c.refDes)
        for (const x of others) {
          if (board.isRail(x) || netSet.has(x)) continue
          for (const q of board.nets.get(x)?.pins ?? []) {
            const o = board.components.get(q.refDes)
            if (o && isAnchor(board, o)) endpoints.add(o.refDes)
          }
        }
      }
    }
    buses.push({
      kind: g.kind,
      name: g.name,
      nets: g.nets,
      diffPairs,
      endpoints: [...endpoints].sort(naturalCompare),
      series: [...series].sort(naturalCompare),
      pulls: [...pulls].sort(naturalCompare),
    })
  }
  return buses.sort((a, b) => naturalCompare(a.kind, b.kind) || naturalCompare(a.name, b.name))
}
