// Input and output of the property-mapping agent (docs/features/auto-repair-attribute-mapping.md). The output schema is also the argument schema of odb_mapping_submit, so
// the model's tool call is checked against it before the validator sees it.

import { tool } from "@opencode-ai/plugin"
import { PROPERTY_FIELDS, type PropertyField } from "../aliases.ts"

const z = tool.schema

/** Bumped when the overlay format changes; older cache entries are dropped. */
export const SCHEMA_VERSION = 1

export type Field = PropertyField
export type Feature = "testPoint" | "rail" | "mechanical"
export type Target = Field | Feature
export type Confidence = "high" | "medium" | "low"

const field = z.enum(PROPERTY_FIELDS as [Field, ...Field[]])
const target = z.enum([...PROPERTY_FIELDS, "testPoint", "rail", "mechanical"] as unknown as [Target, ...Target[]])
const confidence = z.enum(["high", "medium", "low"])
const evidence = z.object({
  refDes: z.array(z.string()).max(5).optional().describe("Up to five refdes you checked"),
  note: z.string().describe("One sentence why the rule is right"),
})

const common = { confidence, evidence }

export const ruleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("propertyAlias"),
    field,
    property: z.string().describe("Property name exactly as it appears in the profile"),
    priority: z.enum(["before", "after"]).optional().describe("Place before or after relativeTo (default: after all aliases)"),
    relativeTo: z.string().optional(),
    scope: z.object({ refdesPrefixes: z.array(z.string()).optional() }).optional(),
    ...common,
  }),
  z.object({
    kind: z.literal("ignoreProperty"),
    property: z.string(),
    reason: z.enum(["internal-number", "distributor-number", "unrelated", "placeholder"]),
    ...common,
  }),
  z.object({
    kind: z.literal("partNameAs"),
    field: z.enum(["value", "mpn"]),
    scope: z.object({ refdesPrefixes: z.array(z.string()).optional(), refdes: z.array(z.string()).optional() }),
    ...common,
  }),
  z.object({
    kind: z.literal("componentValue"),
    refDes: z.string(),
    field,
    value: z.string(),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("property"), property: z.string() }),
      z.object({ kind: z.literal("partName") }),
      z.object({ kind: z.literal("inferred") }),
    ]),
    ...common,
  }),
  z.object({
    kind: z.literal("classify"),
    feature: z.enum(["testPoint", "mechanical"]),
    value: z.boolean(),
    match: z.object({
      refdes: z.array(z.string()).optional(),
      refdesPattern: z.string().optional().describe("JavaScript regex, matched case-insensitively against the refdes"),
      part: z.array(z.string()).optional(),
      package: z.array(z.string()).optional(),
    }),
    ...common,
  }),
  z.object({
    kind: z.literal("rail"),
    nets: z.array(z.string()).min(1),
    value: z.boolean(),
    ...common,
  }),
])

export const unresolvedSchema = z.object({
  target,
  reason: z.enum(["absent-in-export", "ambiguous", "needs-user"]),
  detail: z.string(),
  suggestion: z.string().optional(),
})

export const outputShape = {
  rules: z.array(ruleSchema).describe("Mapping rules, see the system prompt"),
  unresolved: z.array(unresolvedSchema).describe("Targets this export cannot fill"),
  summary: z.string().describe("At most three sentences for the user"),
}
export const outputSchema = z.object(outputShape)

// tool.schema is zod's value export only; read the inferred types off the schemas.
type Infer<T> = T extends { _output: infer O } ? O : never
export type MappingRule = Infer<typeof ruleSchema>
export type Unresolved = Infer<typeof unresolvedSchema>
export interface MappingOutput {
  rules: MappingRule[]
  unresolved: Unresolved[]
  summary: string
}

export type Signal = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7"

export interface Gap {
  signal: Signal
  strength: "strong" | "weak"
  target: Target
  summary: string
  candidates?: string[]
}

export interface MappingInput {
  schemaVersion: number
  design: {
    name: string
    fingerprint: string
    producer?: string
    components: number
    eligibleComponents: number
    nets: number
  }
  targets: {
    fields: Record<Field, { meaning: string; shape: string }>
    features: Record<Feature, { meaning: string }>
  }
  currentMapping: {
    aliases: Record<Field, string[]>
    ignoredProperties: string[]
    coverage: Record<Field, { mapped: number; of: number; sources: Record<string, number> }>
    testPoints: { count: number; sample: string[] }
    rails: { count: number; sample: string[] }
  }
  gaps: Gap[]
  properties: Array<{
    name: string
    count: number
    distinct: number
    mappedTo?: Field | "ignored"
    shapeHits: Partial<Record<Field, number>>
    samples: Array<{ refDes: string; value: string }>
  }>
  partNames: {
    set: number
    equalsPackage: number
    samples: Array<{ refDes: string; part: string; package?: string }>
  }
  refdesClasses: Array<{
    prefix: string
    count: number
    pins: [number, number]
    known: boolean
    samples: Array<{ refDes: string; part?: string; package?: string; nets: string[] }>
  }>
  smallPartCandidates: Array<{ refDes: string; part?: string; package?: string; side?: string; nets: string[] }>
  railCandidates: Array<{ net: string; pins: number; capacitorShare: number }>
  previousMapping?: MappingOutput
  userOverrides?: MappingOutput
}
