// What the explore agents submit (docs/features/board-exploration.md). The
// schemas are also the argument schemas of the submit tools, so the model's
// tool call is shape-checked before the validator sees it.

import { tool } from "@opencode-ai/plugin"

const z = tool.schema

/** Bumped when the cache file format changes; older files are ignored. */
export const UNDERSTANDING_SCHEMA_VERSION = 1

const confidence = z.enum(["high", "medium", "low"])

export const blockResultShape = {
  design: z.string().optional().describe("Design name, if more than one is loaded"),
  block: z.string().describe("Block name exactly as odb_overview / odb_block list it"),
  title: z.string().describe("Short title of what the block is, e.g. 'USB-C 3.2 port with orientation mux'"),
  function: z.string().describe("What the block does, one to three sentences"),
  keyParts: z
    .array(z.object({ refdes: z.string(), role: z.string().describe("Role in the block, e.g. 'USB 3 orientation mux'") }))
    .describe("The parts that define the block: ICs, connectors, regulators, crystals"),
  interfaces: z
    .array(
      z.object({
        name: z.string().describe("Bus or signal group, e.g. 'USB0 SuperSpeed', 'I2C GPIOEX_I2C'"),
        direction: z.enum(["in", "out", "bidir"]).optional(),
        peer: z.string().optional().describe("Block on the other side, if any"),
        description: z.string().optional(),
      }),
    )
    .describe("Signals entering or leaving the block"),
  rails: z.array(z.string()).describe("Supply nets the block uses or produces, exact net names"),
  notes: z.array(z.string()).optional().describe("Anything odd: DNP parts, unconnected interface pins, missing pull-ups"),
  confidence,
  evidence: z.array(z.string()).describe("What the conclusions rest on: parts, datasheet chapters, schematic pages"),
  openQuestions: z.array(z.string()).optional(),
}

export const boardResultShape = {
  design: z.string().optional().describe("Design name, if more than one is loaded"),
  title: z.string().describe("What the board is, e.g. 'Jetson Orin carrier board with 4 MIPI cameras'"),
  purpose: z.string().describe("What the board is for, one to three sentences"),
  summary: z.string().describe("How it works at block level, a short paragraph"),
  dataFlow: z
    .array(
      z.object({
        from: z.string().describe("Block name"),
        to: z.string().describe("Block name"),
        via: z.string().describe("Bus or nets, e.g. 'CSI0', 'USB0_D_P/N'"),
        description: z.string().optional(),
      }),
    )
    .describe("Main signal paths between blocks"),
  power: z.string().describe("Where power enters and how the main rails are made"),
  confidence,
  openQuestions: z.array(z.string()).optional(),
}

const blockResultSchema = z.object(blockResultShape)
const boardResultSchema = z.object(boardResultShape)
// tool.schema is zod's value export only; read the inferred types off the schemas.
type Infer<T> = T extends { _output: infer O } ? O : never
export type BlockResult = Omit<Infer<typeof blockResultSchema>, "design">
export type BoardResult = Omit<Infer<typeof boardResultSchema>, "design">

export const correctionShape = {
  design: z.string().optional(),
  block: z
    .string()
    .optional()
    .describe("Block the correction is about, as odb_overview names it; omit for the board as a whole"),
  title: z.string().optional().describe("New title, if the user named one"),
  function: z.string().optional().describe("What the block (or board) really does, in the user's words"),
  addParts: z.array(z.string()).optional().describe("Refdes the user says belong to this block"),
  removeParts: z.array(z.string()).optional().describe("Refdes the user says do not belong to this block"),
  note: z.string().optional().describe("Anything else the user said, close to verbatim"),
}

/** Bookkeeping stored next to each result, used for staleness. */
export interface EntryMeta {
  createdAt: string
  /** Agent that submitted (odb-explore, odb-block-explore, odb-understanding-fix). */
  agent: string
  promptVersion: number
  groupingVersion: number
  /** SHA-256 over the schematic files, or "" without one. */
  schematicHash: string
  /** Blocks: SHA-256 of the sorted member list. Board: of all block names. */
  membersHash: string
}

export interface UnderstandingFile {
  schemaVersion: number
  design: string
  /** SHA-256 of the archive */
  fingerprint: string
  board?: { result: BoardResult; meta: EntryMeta }
  blocks: Record<string, { result: BlockResult; meta: EntryMeta }>
}
