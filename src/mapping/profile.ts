// Compact profile of a design for the mapping agent (MappingInput,
// docs/plans/property-mapping-agent.md, section 6.1). Every list is capped so
// a 700-part board stays at a few thousand tokens.

import { PROPERTY_FIELDS, normalizePropertyName } from "../aliases.ts"
import { naturalCompare, NO_NET, type BoardComponent, type BoardIndex } from "../board.ts"
import { isKnownRefdes, propertyStats, railCandidateNets, shapeHits, type HealthReport } from "./health.ts"
import { TARGETS } from "./prompt.ts"
import { BUILTIN_IGNORED, refdesPrefix } from "./rules.ts"
import { SCHEMA_VERSION, type Field, type MappingInput, type MappingOutput } from "./schema.ts"

export interface ProfileOptions {
  fingerprint: string
  producer?: string
  previous?: MappingOutput
  user?: MappingOutput
}

export function buildProfile(board: BoardIndex, health: HealthReport, opts: ProfileOptions): MappingInput {
  const eligible = health.eligible
  const all = [...board.components.values()]

  const aliasOf = new Map<string, Field>()
  for (const f of PROPERTY_FIELDS) for (const a of board.mapping.aliases[f]) aliasOf.set(normalizePropertyName(a), f)
  const properties = propertyStats(all)
    .slice(0, 60)
    .map((p) => ({
      name: p.name,
      count: p.values.length,
      distinct: new Set(p.values.map((v) => v.value)).size,
      mappedTo: aliasOf.get(p.key) ?? (BUILTIN_IGNORED.has(p.key) || board.mapping.ignored.has(p.key) ? ("ignored" as const) : undefined),
      shapeHits: shapeHits(p.values.slice(0, 60).map((v) => v.value)),
      samples: spread(p.values, (v) => refdesPrefix(v.refDes), 6).map((v) => ({ refDes: v.refDes, value: cut(v.value, 80) })),
    }))

  const named = all.filter((c) => c.part?.trim())
  const partNames = {
    set: named.length,
    equalsPackage: named.filter((c) => c.part === c.package).length,
    samples: spread(named, (c) => refdesPrefix(c.refDes), 15).map((c) => ({ refDes: c.refDes, part: c.part!, package: c.package })),
  }

  const groups = new Map<string, BoardComponent[]>()
  for (const c of all) {
    const p = refdesPrefix(c.refDes)
    groups.set(p, [...(groups.get(p) ?? []), c])
  }
  const refdesClasses = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 40)
    .map(([prefix, cs]) => {
      const pins = cs.map((c) => c.pins.size)
      return {
        prefix,
        count: cs.length,
        pins: [Math.min(...pins), Math.max(...pins)] as [number, number],
        known: isKnownRefdes(cs[0]),
        samples: cs.slice(0, 4).map((c) => ({ refDes: c.refDes, part: c.part, package: c.package, nets: nets(c, 3) })),
      }
    })

  const smallPartCandidates = eligible
    .filter((c) => c.pins.size <= 2 && (!isKnownRefdes(c) || /tp|test|pad|probe/i.test(`${c.part} ${c.package}`)))
    .sort((a, b) => naturalCompare(a.refDes, b.refDes))
    .slice(0, 40)
    .map((c) => ({ refDes: c.refDes, part: c.part, package: c.package, side: c.side, nets: nets(c, 2) }))

  const testPoints = board.testPoints()
  const rails = [...board.nets.keys()].filter((n) => n !== NO_NET && board.isRail(n))

  return {
    schemaVersion: SCHEMA_VERSION,
    design: {
      name: board.name,
      fingerprint: opts.fingerprint.slice(0, 16),
      producer: opts.producer,
      components: board.components.size,
      eligibleComponents: eligible.length,
      nets: board.nets.size,
    },
    targets: TARGETS as unknown as MappingInput["targets"],
    currentMapping: {
      aliases: board.mapping.aliases,
      ignoredProperties: [...BUILTIN_IGNORED, ...board.mapping.ignored],
      coverage: health.coverage,
      testPoints: { count: testPoints.length, sample: testPoints.slice(0, 10).map((c) => c.refDes) },
      rails: { count: rails.length, sample: rails.slice(0, 15) },
    },
    gaps: health.gaps,
    properties,
    partNames,
    refdesClasses,
    smallPartCandidates,
    railCandidates: railCandidateNets(board).slice(0, 20),
    previousMapping: opts.previous,
    userOverrides: opts.user,
  }
}

/** Distinct values of a property, part name or package, with counts and up to three refdes. */
export function distinctValues(
  board: BoardIndex,
  what: { property?: string; attribute?: "part" | "package"; prefix?: string },
  limit = 200,
): Array<{ value: string; count: number; refDes: string[] }> {
  const key = what.property ? normalizePropertyName(what.property) : undefined
  const counts = new Map<string, string[]>()
  for (const c of board.components.values()) {
    if (what.prefix && refdesPrefix(c.refDes).toUpperCase() !== what.prefix.toUpperCase()) continue
    let v: string | undefined
    if (key) v = Object.entries(c.properties).find(([k]) => normalizePropertyName(k) === key)?.[1]
    else v = what.attribute === "package" ? c.package : c.part
    if (v === undefined) continue
    counts.set(v, [...(counts.get(v) ?? []), c.refDes])
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].length - a[1].length || naturalCompare(a[0], b[0]))
    .slice(0, limit)
    .map(([value, refs]) => ({ value, count: refs.length, refDes: refs.sort(naturalCompare).slice(0, 3) }))
}

function nets(c: BoardComponent, max: number): string[] {
  return [...new Set(c.pins.values())].filter((n) => n !== NO_NET).slice(0, max)
}

/** Up to `max` items, round-robin over groups so every refdes class shows up. */
function spread<T>(items: T[], group: (t: T) => string, max: number): T[] {
  const byGroup = new Map<string, T[]>()
  for (const t of items) byGroup.set(group(t), [...(byGroup.get(group(t)) ?? []), t])
  const lists = [...byGroup.values()]
  const out: T[] = []
  for (let i = 0; out.length < max && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] !== undefined && out.length < max) out.push(l[i])
  }
  return out
}

function cut(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
