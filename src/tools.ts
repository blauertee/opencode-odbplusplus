import { tool, type ToolContext } from "@opencode-ai/plugin"
import { naturalCompare, toRegex, type BoardIndex } from "./board.ts"
import { datasheetText, extractSection } from "./datasheet.ts"
import {
  blockDetail,
  componentDetail,
  componentSummary,
  interfacesDetail,
  mappingStatus,
  netDetail,
  overviewDetail,
  pathsDetail,
  testPointLine,
  testPointsDetail,
} from "./format.ts"
import type { OpencodeAgentRunner } from "./mapping/agent.ts"
import { distinctValues } from "./mapping/profile.ts"
import { outputShape, type MappingOutput, type Target } from "./mapping/schema.ts"
import { WRITE_TOOLS } from "./explore/agents.ts"
import { mentionsDetail, understandingBlock, understandingSummary } from "./explore/format.ts"
import { blockResultShape, boardResultShape, correctionShape } from "./explore/schema.ts"
import type { UnderstandingService } from "./explore/service.ts"
import { detectInterfaces, findBlock, groupBlocks } from "./overview.ts"
import type { DesignStore } from "./store.ts"

const z = tool.schema

const designArg = z
  .string()
  .optional()
  .describe("ODB++ archive: file name in the designs directory (extension optional) or a path. Optional when there is only one.")

export function createTools(store: DesignStore, agent?: OpencodeAgentRunner, understanding?: UnderstandingService) {
  /** Blocks with the user's part moves applied, when corrections are available. */
  const group = (board: BoardIndex) => understanding?.grouping(board) ?? groupBlocks(board)
  const titles = (design: string | undefined) => understanding?.titles(store.handle(design)) ?? new Map<string, string>()
  /** Write tools are for the explore agents only, whatever the permission setup. */
  const writer = (toolName: string, ctx: ToolContext) =>
    WRITE_TOOLS[toolName].includes(ctx.agent)
      ? undefined
      : `${toolName} is only available to ${WRITE_TOOLS[toolName].join(", ")}. To correct saved understanding, launch the odb-understanding-fix subagent.`

  /** Open the design, run `body` and append the "mapping is being repaired" note if one applies. */
  const withBoard = async (
    design: string | undefined,
    ctx: ToolContext,
    body: (board: BoardIndex) => string | Promise<string>,
    waitFor?: Target[],
  ) => {
    const { board, note } = await store.open(design, { sessionID: ctx.sessionID, waitFor })
    const out = await body(board)
    return note ? `${out}\n\n${note}` : out
  }

  return {
    odb_designs: tool({
      description: "List the PCB designs (ODB++ archives) in the designs directory.",
      args: {},
      async execute() {
        const designs = store.list()
        return designs.length ? designs.join("\n") : "No ODB++ archives in the designs directory."
      },
    }),

    odb_component: tool({
      description:
        "Show one component of a PCB design: value, MPN, package, datasheet URL and every pin with its net and the " +
        "other component pins on that net. Use this for 'what is U35 connected to'. Power/ground rails are summarised.",
      args: {
        refdes: z.string().describe("Reference designator, e.g. IC35 or U12"),
        design: designArg,
        neighbours: z.number().int().optional().describe("Max neighbour pins listed per net (default 12)"),
      },
      async execute(args, ctx) {
        return withBoard(args.design, ctx, (board) => {
          const c = board.findComponent(args.refdes)
          if (!c) return notFound(board.components.keys(), args.refdes, "component")
          return componentDetail(board, c, args.neighbours ?? 12)
        })
      },
    }),

    odb_net: tool({
      description:
        "List everything connected to a net (e.g. '+5V', 'GND', 'I2C1_SDA'), grouped by component with value and MPN. " +
        "Hierarchical KiCad names ('/CSI/CSI1_D0_N') also match by their last segment.",
      args: {
        net: z.string().describe("Net name"),
        design: designArg,
      },
      async execute(args, ctx) {
        return withBoard(args.design, ctx, (board) => {
          const nets = board.findNets(args.net)
          if (nets.length === 0) return notFound(board.nets.keys(), args.net, "net")
          if (nets.length > 1) return `Ambiguous net name, candidates:\n${nets.map((n) => n.name).join("\n")}`
          return netDetail(board, nets[0].name)
        })
      },
    }),

    odb_signal_path: tool({
      description:
        "Find the component chains connecting two components, e.g. everything between U10 and U35 on the signal " +
        "path. Walks shared signal nets, skips power/ground rails, and by default only passes through small " +
        "components (<= 4 pins: resistors, capacitors, ferrites, ESD diodes). Raise max_pins_through to pass " +
        "through buffers or level shifters.",
      args: {
        from: z.string().describe("Start reference designator"),
        to: z.string().describe("End reference designator"),
        design: designArg,
        max_pins_through: z.number().int().optional().describe("Max pin count of intermediate parts (default 4)"),
        max_depth: z.number().int().optional().describe("Max components per chain (default 8)"),
        max_paths: z.number().int().optional().describe("Max chains returned (default 10)"),
        include_rails: z.boolean().optional().describe("Also walk power/ground nets (default false)"),
      },
      async execute(args, ctx) {
        return withBoard(args.design, ctx, (board) => {
          for (const ref of [args.from, args.to]) {
            if (!board.findComponent(ref)) return notFound(board.components.keys(), ref, "component")
          }
          const paths = board.signalPaths(args.from, args.to, {
            maxPinsThrough: args.max_pins_through,
            maxDepth: args.max_depth,
            maxPaths: args.max_paths,
            includeRails: args.include_rails,
          })
          if (!paths.length) {
            return `No signal chain from ${args.from} to ${args.to} within the limits. Try a larger max_pins_through or max_depth.`
          }
          return pathsDetail(board, paths)
        })
      },
    }),

    odb_search: tool({
      description:
        "Search components (refdes, value, MPN, description, package) and nets by substring or regex, e.g. " +
        "'STM32', '^U', 'USB.*_D[PN]'.",
      args: {
        query: z.string().describe("Substring or regular expression (case-insensitive)"),
        design: designArg,
        limit: z.number().int().optional().describe("Max results per category (default 50)"),
      },
      async execute(args, ctx) {
        // A query that looks like a part number needs the MPN mapping.
        const waitFor: Target[] | undefined = /[a-z]/i.test(args.query) && /\d/.test(args.query) ? ["mpn", "value"] : undefined
        return withBoard(
          args.design,
          ctx,
          (board) => {
            const { components, nets } = board.search(args.query, args.limit ?? 50)
            const out: string[] = [`## Components (${components.length})`]
            for (const c of components) out.push(componentSummary(board, c))
            out.push("", `## Nets (${nets.length})`)
            for (const n of nets) out.push(`${n.name} (${n.pins.length} pins)`)
            return out.join("\n")
          },
          waitFor,
        )
      },
    }),

    odb_overview: tool({
      description:
        "Bird's-eye view of a PCB design: what the board is and does. Lists inferred functional blocks (from " +
        "schematic sheet names in net names, per-sheet refdes numbering, or connectivity around ICs and " +
        "connectors) with their key parts, the interfaces found by net names (USB, PCIe, I2C, SPI, ...) and the " +
        "supply rails. Start here before drilling into components; then use odb_block and odb_interfaces.",
      args: { design: designArg },
      async execute(args, ctx) {
        return withBoard(args.design, ctx, (board) => overviewDetail(board, group(board), detectInterfaces(board), titles(args.design)), [
          "value",
          "description",
        ])
      },
    }),

    odb_block: tool({
      description:
        "One functional block from odb_overview: its key parts (ICs, connectors) with value and description, the " +
        "other parts by type, supply rails, and every signal net that leaves the block with the blocks on the " +
        "other side. Name the block as odb_overview lists it (e.g. 'USB3', '7xxx', 'U6'), or pass a refdes to " +
        "get the block that part belongs to.",
      args: {
        block: z.string().describe("Block name from odb_overview, or a member refdes"),
        design: designArg,
      },
      async execute(args, ctx) {
        return withBoard(
          args.design,
          ctx,
          (board) => {
            const g = group(board)
            const b = findBlock(g, args.block)
            if (!b) {
              const placed = board.findComponent(args.block)
              if (placed && g.unassigned.includes(placed.refDes)) return `${placed.refDes} is not placed in any block.`
              return `No block named ${args.block}. Blocks: ${g.blocks.map((x) => x.name).join(", ")}`
            }
            return blockDetail(board, g, b, titles(args.design).get(b.name))
          },
          ["value", "description"],
        )
      },
    }),

    odb_interfaces: tool({
      description:
        "Interface buses recognised by net names (MIPI CSI/DSI, HDMI, DisplayPort, PCIe, USB, Ethernet, SD, " +
        "JTAG, I2S, CAN, I2C, SPI, UART): per bus its nets, differential pairs, the ICs/connectors at its ends " +
        "(seen through series resistors), series parts and pull-ups. Filter by kind or by a part on the bus.",
      args: {
        kind: z.string().optional().describe("Interface kind or bus name substring, e.g. 'I2C', 'USB', 'CSI0'"),
        refdes: z.string().optional().describe("Only buses that end at or pass through this part"),
        design: designArg,
      },
      async execute(args, ctx) {
        return withBoard(
          args.design,
          ctx,
          (board) => {
            let buses = detectInterfaces(board)
            if (args.kind) {
              const re = toRegex(args.kind)
              buses = buses.filter((b) => re.test(b.kind) || re.test(b.name))
            }
            if (args.refdes) {
              const c = board.findComponent(args.refdes)
              if (!c) return notFound(board.components.keys(), args.refdes, "component")
              buses = buses.filter((b) => [...b.endpoints, ...b.series, ...b.pulls].includes(c.refDes))
            }
            if (!buses.length) return "No matching interface buses. Net names may not follow common conventions; try odb_search."
            return interfacesDetail(board, buses, group(board))
          },
          ["value"],
        )
      },
    }),

    odb_understanding: tool({
      description:
        "Saved high-level understanding of a PCB design: what the board is for, each block's title and function, " +
        "data flow and power, as worked out by the odb-explore agents and corrected by the user (corrections win). " +
        "Also lists schematic files that came with the design and which blocks are not explored or stale. With " +
        "block: one block in full. With mentions: which saved results mention a refdes, net or term. action " +
        "'reset' drops the saved agent results (never the user's corrections file). Read-only otherwise. If the " +
        "user corrects anything shown here, launch the odb-understanding-fix subagent.",
      args: {
        design: designArg,
        block: z.string().optional().describe("Block name (or a member refdes) for the full saved result"),
        mentions: z.string().optional().describe("Refdes, net or term to search the saved results for"),
        action: z.enum(["show", "reset"]).optional().describe("Default: show"),
      },
      async execute(args, ctx) {
        if (!understanding) return "Board understanding is not available in this setup."
        return withBoard(args.design, ctx, (board) => {
          const h = store.handle(args.design)
          if (args.action === "reset") {
            understanding.reset(h)
            return "Saved agent results dropped. The user's corrections file is unchanged."
          }
          const u = understanding.context(h)
          if (args.mentions) {
            const terms = args.mentions.split(/[\s,]+/).filter(Boolean)
            return mentionsDetail(u, understanding.mentioning(u, terms), args.mentions)
          }
          if (args.block) {
            const b = findBlock(u.grouping, args.block)
            if (!b) return `No block named ${args.block}. Blocks: ${u.grouping.blocks.map((x) => x.name).join(", ")}`
            return understandingBlock(understanding, u, b, board)
          }
          return understandingSummary(understanding, u)
        })
      },
    }),

    odb_explore_submit_block: tool({
      description:
        "Explore agents only: save what one block does. Checked against the board data; rejected parts come back " +
        "as text so you can fix them and submit again.",
      args: blockResultShape,
      async execute(args, ctx) {
        const denied = writer("odb_explore_submit_block", ctx)
        if (denied || !understanding) return denied ?? "Board understanding is not available in this setup."
        const { design, ...result } = args
        return understanding.submitBlock(store.handle(design), result, ctx.agent)
      },
    }),

    odb_explore_submit_board: tool({
      description:
        "Explore agents only: save the board-level understanding (title, purpose, summary, data flow between " +
        "blocks, power). Checked against the board data.",
      args: boardResultShape,
      async execute(args, ctx) {
        const denied = writer("odb_explore_submit_board", ctx)
        if (denied || !understanding) return denied ?? "Board understanding is not available in this setup."
        const { design, ...result } = args
        return understanding.submitBoard(store.handle(design), result, ctx.agent)
      },
    }),

    odb_understanding_correct: tool({
      description:
        "odb-understanding-fix only: record a user's correction in <design>.understanding.md next to the archive. " +
        "It wins over saved agent results everywhere. Returns the saved results that mention the corrected block " +
        "or parts, which you then rewrite with the submit tools.",
      args: correctionShape,
      async execute(args, ctx) {
        const denied = writer("odb_understanding_correct", ctx)
        if (denied || !understanding) return denied ?? "Board understanding is not available in this setup."
        const { design, ...input } = args
        if (!input.title && !input.function && !input.addParts?.length && !input.removeParts?.length && !input.note) {
          return "Nothing to record: pass title, function, addParts, removeParts or note."
        }
        return understanding.correct(store.handle(design), input)
      },
    }),

    odb_testpoints: tool({
      description:
        "Test points (test pads) of a PCB design with net, board side and position. With net: the test points on " +
        "that net ('which test pad do I probe for I2C1_SDA'). With refdes: the net on that test point ('what is on " +
        "TP21'). With neither: all test points. Test points are recognised by TP<n> refdes or a TP/TestPoint " +
        "footprint or value on a 1-2 pin part, or by the design's property mapping; pass pattern to match refdes " +
        "differently.",
      args: {
        net: z.string().optional().describe("Net name, e.g. 'I2C1_SDA' or '/M.2/M2_M_SMB_DATA'"),
        refdes: z.string().optional().describe("Test point reference designator, e.g. TP21"),
        design: designArg,
        pattern: z
          .string()
          .optional()
          .describe("Refdes substring or regex that marks test points instead of the default rule, e.g. '^(TP|TEST)'"),
      },
      async execute(args, ctx) {
        return withBoard(
          args.design,
          ctx,
          (board) => {
            const pattern = args.pattern ? toRegex(args.pattern) : undefined

            if (args.refdes) {
              const c = board.findComponent(args.refdes)
              if (!c) return notFound(board.components.keys(), args.refdes, "component")
              if (board.isTestPoint(c, pattern)) return testPointLine(c)
              return `${c.refDes} is not a test point (${componentSummary(board, c)}). Use odb_component for its pins.`
            }

            if (args.net) {
              const nets = board.findNets(args.net)
              if (nets.length === 0) return notFound(board.nets.keys(), args.net, "net")
              if (nets.length > 1) return `Ambiguous net name, candidates:\n${nets.map((n) => n.name).join("\n")}`
              const net = nets[0].name
              const tps = board.testPoints({ net, pattern })
              if (tps.length) return testPointsDetail(`Test points on ${net}`, tps)
              return `No test point on ${net}. Use odb_net to see what else is on it.`
            }

            const tps = board.testPoints({ pattern })
            return tps.length
              ? testPointsDetail("Test points", tps)
              : "No test points found. Try pattern with the refdes prefix this design uses."
          },
          ["testPoint"],
        )
      },
    }),

    odb_datasheet: tool({
      description:
        "Fetch the datasheet of a component (from its Datasheet property) and return one chapter, e.g. " +
        "'Description', 'Pin Configuration', 'Absolute Maximum Ratings'. Without section, lists the datasheet's " +
        "first lines. Needs poppler's pdftotext on the PATH.",
      args: {
        refdes: z.string().describe("Reference designator"),
        section: z.string().optional().describe("Chapter heading to extract (default: overview)"),
        design: designArg,
      },
      async execute(args, ctx) {
        return withBoard(
          args.design,
          ctx,
          async (board) => {
            const c = board.findComponent(args.refdes)
            if (!c) return notFound(board.components.keys(), args.refdes, "component")
            const url = board.datasheet(c)
            if (!url) return `${c.refDes} has no datasheet property. ${componentSummary(board, c)}`
            const text = await datasheetText(url)
            if (!args.section) return `datasheet: ${url}\n\n${text.slice(0, 4000)}`
            const chapter = extractSection(text, args.section)
            return chapter
              ? `datasheet: ${url}\n\n${chapter}`
              : `Section "${args.section}" not found in ${url}. Retry with another heading or without section.`
          },
          ["datasheet"],
        )
      },
    }),

    odb_mapping: tool({
      description:
        "Show how a design's component properties are mapped to value, MPN, datasheet, description, manufacturer, " +
        "test points and rails: coverage, detected gaps and the rules in use. action 'repair' re-runs the mapping " +
        "agent, 'reset' drops its stored result (with conventions: true also the conventions learned on other designs).",
      args: {
        design: designArg,
        action: z.enum(["status", "repair", "reset"]).optional().describe("Default: status"),
        conventions: z.boolean().optional().describe("With reset: also forget learned property conventions"),
      },
      async execute(args, ctx) {
        const h = store.handle(args.design)
        if (args.action === "reset") store.mapping.reset(h, !!args.conventions)
        if (args.action === "repair") {
          if (!store.mapping.opts.agent) return "The mapping agent is not available in this setup (mappingAgent is off or there is no OpenCode client)."
          await store.mapping.repair(h, ctx.sessionID)
        }
        return mappingStatus(h)
      },
    }),

    // ---- tools of the odb-mapper agent (disabled for every other agent, see src/index.ts)

    odb_mapping_profile: tool({
      description: "Mapping agent only: the design profile you were given, or one section of it.",
      args: { section: z.string().optional().describe("Top-level key of the profile, e.g. 'properties' or 'gaps'") },
      async execute(args, ctx) {
        const run = agent?.state(ctx.sessionID)
        if (!run) return "Only available to the mapping agent."
        const value = args.section ? (run.input as unknown as Record<string, unknown>)[args.section] : run.input
        return JSON.stringify(value ?? `No section ${args.section}`)
      },
    }),

    odb_mapping_values: tool({
      description:
        "Mapping agent only: all distinct values of one component property, or of the part name or package, with " +
        "counts and up to three refdes each. Optionally only for one refdes prefix (e.g. 'U', 'FMU-').",
      args: {
        property: z.string().optional().describe("Property name"),
        attribute: z.enum(["part", "package"]).optional().describe("Instead of a property"),
        prefix: z.string().optional().describe("Refdes prefix as in refdesClasses"),
      },
      async execute(args, ctx) {
        const run = agent?.state(ctx.sessionID)
        if (!run) return "Only available to the mapping agent."
        if (!args.property && !args.attribute) return "Pass property or attribute."
        const rows = distinctValues(run.board, args)
        if (!rows.length) return "No values."
        return rows.map((r) => `${r.value} | ${r.count} | ${r.refDes.join(", ")}`).join("\n")
      },
    }),

    odb_mapping_submit: tool({
      description: "Mapping agent only: submit the complete mapping (rules, unresolved, summary). Returns what was accepted.",
      args: outputShape,
      async execute(args, ctx) {
        if (!agent) return "Only available to the mapping agent."
        return agent.submit(ctx.sessionID, args as MappingOutput)
      },
    }),
  }
}

function notFound(names: Iterable<string>, wanted: string, kind: string): string {
  const w = wanted.toUpperCase()
  const prefix = w.replace(/\d+$/, "")
  const close = [...names].filter((n) => n.toUpperCase().startsWith(prefix)).sort(naturalCompare).slice(0, 20)
  return `No ${kind} named ${wanted}.${close.length ? ` Similar: ${close.join(", ")}` : ""}`
}
