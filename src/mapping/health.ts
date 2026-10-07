// Mapping health check: does a design look like we are missing data the
// tools need? Deterministic and cheap, runs on every load
// (docs/features/auto-repair-attribute-mapping.md).

import { KNOWN_REFDES_PREFIXES, normalizePropertyName, PROPERTY_FIELDS } from "../aliases.ts"
import { NO_NET, type BoardComponent, type BoardIndex } from "../board.ts"
import { checkMpn, isPassiveValue } from "./mpn.ts"
import { BUILTIN_IGNORED, isPlaceholder, refdesPrefix } from "./rules.ts"
import type { Field, Gap } from "./schema.ts"

/** Bumped when the signals or thresholds change; allows a new agent run on cached designs. */
export const HEURISTIC_VERSION = 1

const KNOWN = new Set(KNOWN_REFDES_PREFIXES)
const PASSIVE_PREFIXES = new Set(["R", "C", "L", "FB", "RN", "RV", "RT"])
const MANUFACTURERS =
  /\b(?:murata|yageo|panasonic|samsung|kemet|vishay|rohm|tdk|texas|ti|stmicro|st|nxp|nexperia|infineon|onsemi|microchip|analog|maxim|bourns|wurth|würth|molex|te|amphenol|hirose|jst|littelfuse|diodes|toshiba|renesas|espressif|nordic|silicon|ftdi|lite-on|kingbright|everlight|abracon|epson|ecs|walsin|uniroyal|kyocera|avx|taiyo|coilcraft|sunlord|bel|cui|samtec|harwin|keystone|wago|phoenix|omron|alps|e-switch|ck)\b/i

export interface FieldCoverage {
  mapped: number
  of: number
  sources: Record<string, number>
}

export interface HealthReport {
  heuristicVersion: number
  eligible: BoardComponent[]
  coverage: Record<Field, FieldCoverage>
  testPoints: number
  gaps: Gap[]
  /** Whether the gaps justify an agent run (strong signal, or two weak ones). */
  launch: boolean
}

/** A part counts for the health check if it has a pin on a real net and is not mechanical. */
export function eligibleComponents(board: BoardIndex): BoardComponent[] {
  return [...board.components.values()].filter((c) => !board.isMechanical(c) && [...c.pins.values()].some((n) => n !== NO_NET))
}

export function isPassive(c: BoardComponent): boolean {
  return PASSIVE_PREFIXES.has(refdesPrefix(c.refDes).toUpperCase())
}

export function isKnownRefdes(c: BoardComponent): boolean {
  return KNOWN.has(refdesPrefix(c.refDes).toUpperCase())
}

/** Share (0..1) of values that look like each field. */
export function shapeHits(values: string[]): Partial<Record<Field, number>> {
  if (!values.length) return {}
  const share = (pred: (v: string) => boolean) => round(values.filter(pred).length / values.length)
  const distinct = new Set(values).size
  const out: Partial<Record<Field, number>> = {
    mpn: share((v) => /[a-z]/i.test(v) && /\d/.test(v) && checkMpn(v).verdict !== "reject"),
    value: share((v) => isPassiveValue(v)),
    datasheet: share((v) => /^(?:https?:\/\/|www\.)/i.test(v) || /\.pdf$/i.test(v)),
    description: share((v) => v.trim().split(/\s+/).length >= 3),
    manufacturer: share((v) => MANUFACTURERS.test(v) || (distinct <= Math.max(3, values.length / 3) && /^[a-z][\w&.,'-]*(?:\s[\w&.,'-]+){0,2}$/i.test(v.trim()))),
  }
  for (const k of Object.keys(out) as Field[]) if (!out[k]) delete out[k]
  return out
}

export interface PropertyStat {
  /** Most common spelling of the name */
  name: string
  key: string
  values: Array<{ refDes: string; value: string }>
}

/** Non-placeholder property values on the given parts, grouped by normalized name. */
export function propertyStats(parts: BoardComponent[]): PropertyStat[] {
  const byKey = new Map<string, { spellings: Map<string, number>; values: Array<{ refDes: string; value: string }> }>()
  for (const c of parts) {
    for (const [k, v] of Object.entries(c.properties)) {
      if (isPlaceholder(v)) continue
      const key = normalizePropertyName(k)
      const e = byKey.get(key) ?? { spellings: new Map<string, number>(), values: [] as Array<{ refDes: string; value: string }> }
      e.spellings.set(k, (e.spellings.get(k) ?? 0) + 1)
      e.values.push({ refDes: c.refDes, value: v.trim() })
      byKey.set(key, e)
    }
  }
  return [...byKey.entries()]
    .map(([key, e]) => ({ key, name: [...e.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0], values: e.values }))
    .sort((a, b) => b.values.length - a.values.length)
}

export function mappingHealth(board: BoardIndex): HealthReport {
  const eligible = eligibleComponents(board)
  const gaps: Gap[] = []
  const n = eligible.length

  // ---------------------------------------------------------- coverage
  const coverage = {} as Record<Field, FieldCoverage>
  for (const f of PROPERTY_FIELDS) {
    const of = f === "mpn" ? eligible.filter((c) => !isPassive(c)).length : n
    const sources: Record<string, number> = {}
    let mapped = 0
    for (const c of eligible) {
      if (f === "mpn" && isPassive(c)) continue
      const r = board.resolve(c, f)[0]
      if (!r) continue
      mapped++
      sources[r.source] = (sources[r.source] ?? 0) + 1
    }
    coverage[f] = { mapped, of, sources }
  }
  const ratio = (f: Field) => (coverage[f].of ? coverage[f].mapped / coverage[f].of : 1)

  // ---------------------------------------------- S1 unmapped carriers
  const mappedKeys = new Set(PROPERTY_FIELDS.flatMap((f) => board.mapping.aliases[f].map(normalizePropertyName)))
  for (const s of board.mapping.scopedAliases) mappedKeys.add(normalizePropertyName(s.property))
  const stats = propertyStats(eligible)
  const minCount = Math.max(5, Math.ceil(n * 0.1))
  const s1 = new Map<Field, string[]>()
  for (const p of stats) {
    if (p.values.length < minCount) continue
    if (mappedKeys.has(p.key) || BUILTIN_IGNORED.has(p.key) || board.mapping.ignored.has(p.key)) continue
    const hits = shapeHits(p.values.slice(0, 60).map((v) => v.value))
    for (const f of PROPERTY_FIELDS) {
      if ((hits[f] ?? 0) >= 0.6 && ratio(f) < 0.9) s1.set(f, [...(s1.get(f) ?? []), p.name])
    }
  }
  for (const [f, names] of s1) {
    gaps.push({
      signal: "S1",
      strength: "strong",
      target: f,
      summary: `${f} set on ${coverage[f].mapped} of ${coverage[f].of} parts; unmapped properties look like it: ${names.join(", ")}`,
      candidates: names,
    })
  }

  // ------------------------------- S2 low coverage, usable part names
  const partNameUsable = (cs: BoardComponent[]) =>
    cs.length > 0 && cs.filter((c) => c.part && c.part !== c.package).length / cs.length >= 0.5
  const uncovered = (f: Field) =>
    eligible.filter((c) => !(f === "mpn" && isPassive(c)) && board.resolve(c, f).length === 0)
  if (ratio("value") < 0.7 && partNameUsable(uncovered("value"))) {
    gaps.push({ signal: "S2", strength: "strong", target: "value", summary: `value set on ${coverage.value.mapped} of ${n} parts, but most uncovered parts have a part name` })
  }
  if (ratio("mpn") < 0.5 && partNameUsable(uncovered("mpn"))) {
    gaps.push({ signal: "S2", strength: "strong", target: "mpn", summary: `mpn set on ${coverage.mpn.mapped} of ${coverage.mpn.of} non-passive parts, but most uncovered parts have a part name` })
  }

  // ---------------------------------------------------- S3 test points
  const testPoints = board.testPoints().length
  const orphans = eligible.filter((c) => c.pins.size <= 2 && !isKnownRefdes(c) && !board.isTestPoint(c))
  if ((testPoints === 0 && orphans.length >= 3) || orphans.length >= 5) {
    gaps.push({
      signal: "S3",
      strength: "strong",
      target: "testPoint",
      summary: `${testPoints} test points found; ${orphans.length} parts with at most two pins have unknown refdes prefixes`,
      candidates: orphans.slice(0, 40).map((c) => c.refDes),
    })
  }

  // ------------------------------------------- S4 unclassified refdes
  const unknown = eligible.filter((c) => !isKnownRefdes(c))
  if (unknown.length >= 3 && unknown.length >= n * 0.03) {
    const prefixes = [...new Set(unknown.map((c) => refdesPrefix(c.refDes)))]
    gaps.push({
      signal: "S4",
      strength: "weak",
      target: "mechanical",
      summary: `${unknown.length} parts have refdes prefixes outside the known classes: ${prefixes.slice(0, 15).join(", ")}`,
      candidates: prefixes.slice(0, 40),
    })
  }

  // -------------------------------------------- S5 suspicious MPN source
  const mpnValues = eligible
    .map((c) => ({ c, r: board.resolve(c, "mpn")[0] }))
    .filter((x) => x.r && !x.r.inferred)
  const bad = mpnValues.filter(({ c, r }) => checkMpn(r!.value, { package: c.package, pins: c.pins.size }).verdict === "reject")
  if (mpnValues.length >= 5 && bad.length / mpnValues.length >= 0.3) {
    const sources = [...new Set(bad.map((b) => b.r!.source))]
    gaps.push({
      signal: "S5",
      strength: "strong",
      target: "mpn",
      summary: `${bad.length} of ${mpnValues.length} MPN values cannot be part numbers (e.g. ${bad.slice(0, 3).map((b) => `${b.c.refDes}: ${b.r!.value}`).join(", ")})`,
      candidates: sources,
    })
  }

  // ------------------------------------------------------ S6 rail gap
  const railCandidates = railCandidateNets(board)
  if (railCandidates.length) {
    gaps.push({
      signal: "S6",
      strength: "weak",
      target: "rail",
      summary: `${railCandidates.length} high-fanout nets mostly on capacitors are not treated as rails`,
      candidates: railCandidates.slice(0, 20).map((r) => r.net),
    })
  }

  // -------------------------------------------- S7 placeholder values
  for (const f of PROPERTY_FIELDS) {
    const keys = new Set(board.mapping.aliases[f].map(normalizePropertyName))
    let present = 0
    let placeholder = 0
    for (const c of eligible) {
      // Empty strings mean "not filled in", not a placeholder.
      const vals = Object.entries(c.properties)
        .filter(([k, v]) => keys.has(normalizePropertyName(k)) && v.trim() !== "")
        .map(([, v]) => v)
      if (!vals.length) continue
      present++
      if (vals.every(isPlaceholder)) placeholder++
    }
    if (placeholder >= 5 && placeholder / present >= 0.2) {
      gaps.push({ signal: "S7", strength: "weak", target: f, summary: `${placeholder} of ${present} ${f} properties are placeholders` })
    }
  }

  const strong = gaps.filter((g) => g.strength === "strong").length
  const weak = gaps.length - strong
  return { heuristicVersion: HEURISTIC_VERSION, eligible, coverage, testPoints, gaps, launch: n >= 5 && (strong > 0 || weak >= 2) }
}

/** Nets with fanout >= 20, mostly on two-pin capacitors, not already rails. */
export function railCandidateNets(board: BoardIndex): Array<{ net: string; pins: number; capacitorShare: number }> {
  const out: Array<{ net: string; pins: number; capacitorShare: number }> = []
  for (const net of board.nets.values()) {
    if (net.pins.length < 20 || board.isRail(net.name)) continue
    const caps = net.pins.filter((p) => {
      const c = board.components.get(p.refDes)
      return c && c.pins.size === 2 && refdesPrefix(c.refDes).toUpperCase() === "C"
    }).length
    const share = caps / net.pins.length
    if (share >= 0.6) out.push({ net: net.name, pins: net.pins.length, capacitorShare: round(share) })
  }
  return out.sort((a, b) => b.pins - a.pins)
}

function round(x: number) {
  return Math.round(x * 100) / 100
}
