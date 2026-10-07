import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyExploreConfig, BLOCK_AGENT, EXPLORE_AGENT, FIX_AGENT } from "../src/explore/agents.ts"
import { editCorrections, parseCorrections } from "../src/explore/corrections.ts"
import { FIX_RULE } from "../src/explore/prompts.ts"
import { findSchematics, schematicHash } from "../src/explore/schematic.ts"
import type { BlockResult, BoardResult } from "../src/explore/schema.ts"
import { UnderstandingService } from "../src/explore/service.ts"
import type { NativeBoard, NativeNet } from "../src/native.ts"
import { DesignStore } from "../src/store.ts"
import { createTools } from "../src/tools.ts"

const tmp = mkdtempSync(join(tmpdir(), "odb-explore-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// Same shape as the KiCad fixture in overview.test.ts: an MCU sheet and a USB sheet.
function fixture(): NativeBoard {
  const nets: Record<string, string[]> = {
    "+3V3": ["U1.1", "U2.1", "C1.1", "C2.1", "R3.1"],
    GND: ["U1.2", "U2.2", "C1.2", "C2.2"],
    "/MCU/XTAL_IN": ["U1.3", "Y1.1"],
    "/MCU/XTAL_OUT": ["U1.4", "Y1.2"],
    "/USB/USB_D_P": ["U2.3", "R1.1"],
    "/USB/USB_D_N": ["U2.4", "R2.1"],
    USB_CONN_D_P: ["R1.2", "J1.1"],
    USB_CONN_D_N: ["R2.2", "J1.2"],
    I2C_SDA: ["U1.5", "U2.5", "R3.2"],
    I2C_SCL: ["U1.6", "U2.6"],
  }
  const components = [
    { refDes: "U1", props: { Value: "STM32G0" }, x: 0, y: 0 },
    { refDes: "U2", props: { Value: "USB2514" }, x: 50, y: 0 },
    { refDes: "J1", x: 60, y: 0 },
    { refDes: "Y1", x: 2, y: 0 },
    { refDes: "R1", x: 55, y: 0 },
    { refDes: "R2", x: 55, y: 1 },
    { refDes: "R3", x: 25, y: 0 },
    { refDes: "C1", x: 1, y: 1 },
    { refDes: "C2", x: 49, y: 1 },
  ]
  const native: NativeNet[] = Object.entries(nets).map(([name, pins]) => ({ name, pins: pins.map((p) => p.split(".") as [string, string]) }))
  const pad: [string, string][] = []
  for (const c of components) if (/^(U|J)/.test(c.refDes)) for (let i = 1; i <= 8; i++) pad.push([c.refDes, `nc${i}`])
  native.push({ name: "$NONE$", pins: pad })
  return { name: "fixture", components, nets: native }
}

function setup(name: string) {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "fixture.tgz"), name)
  const store = new DesignStore(dir, "fixture", () => fixture())
  const svc = new UnderstandingService({ designsDir: dir, cacheDir: join(dir, "cache") })
  const tools = createTools(store, undefined, svc)
  const call = async (tool: keyof typeof tools, args: Record<string, unknown>, agent = "build") =>
    String(await (tools[tool].execute as (a: unknown, c: unknown) => Promise<unknown>)(args, { sessionID: "s", agent }))
  return { dir, store, svc, call }
}

const usbBlock: BlockResult = {
  block: "usb",
  title: "USB hub",
  function: "Four-port USB 2.0 hub behind the connector.",
  keyParts: [{ refdes: "U2", role: "hub controller" }, { refdes: "J1", role: "upstream connector" }],
  interfaces: [{ name: "USB upstream", direction: "bidir", peer: "outside" }, { name: "I2C config", peer: "mcu" }],
  rails: ["+3v3"],
  confidence: "medium",
  evidence: ["U2 value USB2514"],
}

const boardResult: BoardResult = {
  title: "MCU board with USB hub",
  purpose: "Test fixture.",
  summary: "An MCU configures a USB hub over I2C.",
  dataFlow: [{ from: "MCU", to: "USB", via: "I2C_SDA/I2C_SCL", description: "hub configuration" }],
  power: "+3V3 from outside",
  confidence: "high",
}

describe("corrections file", () => {
  test("parses board and block sections, key lines and notes", () => {
    const c = parseCorrections(
      [
        "Intro line",
        "# Board",
        "title: Camera carrier",
        "Factory-only debug port.",
        "## Block USB3",
        "title: USB-C host port",
        "purpose: SuperSpeed only",
        "parts: +R12 -U19, -U20",
        "U19-U21 are ESD only.",
        "## CSI",
        "parts: R5",
      ].join("\n"),
    )
    expect(c.board).toMatchObject({ title: "Camera carrier", notes: ["Intro line", "Factory-only debug port."] })
    expect(c.blocks.get("USB3")).toEqual({ title: "USB-C host port", function: "SuperSpeed only", add: ["R12"], remove: ["U19", "U20"], notes: ["U19-U21 are ESD only."] })
    expect(c.blocks.has("CSI")).toBe(true)
    expect(c.errors).toEqual(['line 11 (block CSI): "R5" is not +REFDES or -REFDES'])
  })

  test("edits only the lines it owns", () => {
    const before = "# My notes\nkeep me\n\n## Block USB3\ntitle: old\nparts: +R12\nfree text\n\n## Block CSI\nother\n"
    let text = editCorrections(before, { block: "usb3", title: "new", addParts: ["R13"], removeParts: ["R12"], note: "U19 is ESD only" })
    expect(text).toBe("# My notes\nkeep me\n\n## Block USB3\ntitle: new\nparts: -R12 +R13\nfree text\n- U19 is ESD only\n\n## Block CSI\nother\n")
    text = editCorrections(text, { function: "Camera carrier" })
    expect(text.startsWith("# Board\nfunction: Camera carrier\n\n# My notes")).toBe(true)
    text = editCorrections(text, { block: "HDMI", addParts: ["U36"] })
    expect(text.endsWith("other\n\n## Block HDMI\nparts: +U36\n")).toBe(true)
    expect(parseCorrections(text).errors).toEqual([])
  })
})

describe("schematic discovery", () => {
  test("finds files of any type next to the archive, text first, and hashes them", () => {
    const dir = join(tmp, "sch")
    mkdirSync(join(dir, "board.schematic"), { recursive: true })
    writeFileSync(join(dir, "board.schematic.pdf"), "%PDF")
    writeFileSync(join(dir, "board.sch.md"), "# Sheet 1")
    writeFileSync(join(dir, "board.schematic", "page2.png"), "png")
    writeFileSync(join(dir, "other.schematic.pdf"), "x")
    writeFileSync(join(dir, "extra.txt"), "extra")
    const files = findSchematics(dir, "board", ["extra.txt"])
    expect(files.map((f) => f.path.slice(dir.length + 1))).toEqual(["board.sch.md", "extra.txt", "board.schematic.pdf", "board.schematic/page2.png"])
    const h = schematicHash(files)
    writeFileSync(join(dir, "board.sch.md"), "# Sheet 1 changed")
    expect(schematicHash(findSchematics(dir, "board", ["extra.txt"]))).not.toBe(h)
    expect(schematicHash([])).toBe("")
  })
})

describe("saved understanding", () => {
  test("only explore agents may write", async () => {
    const { call } = setup("guard")
    expect(await call("odb_explore_submit_block", usbBlock)).toContain("only available to")
    expect(await call("odb_understanding_correct", { block: "USB", note: "x" }, BLOCK_AGENT)).toContain("only available to odb-understanding-fix")
  })

  test("checks block submits against the board", async () => {
    const { call } = setup("block")
    const bad = await call(
      "odb_explore_submit_block",
      { ...usbBlock, keyParts: [{ refdes: "U1", role: "x" }, { refdes: "U9", role: "x" }], rails: ["+12V"] },
      BLOCK_AGENT,
    )
    expect(bad).toContain("rejected")
    expect(bad).toContain("U1 is not in USB but in MCU")
    expect(bad).toContain("no component U9")
    expect(bad).toContain("no unique net named +12V")

    const ok = await call("odb_explore_submit_block", usbBlock, BLOCK_AGENT)
    expect(ok).toContain("Block USB saved.")
    expect(ok).toContain('"outside" is not a block name')
    const shown = await call("odb_understanding", {})
    expect(shown).toContain('- USB "USB hub": Four-port USB 2.0 hub behind the connector.')
    expect(shown).toContain("- MCU: 4 parts, key parts U1 [not explored]")
    expect(shown).toContain(FIX_RULE)
    expect(await call("odb_overview", {})).toContain('- USB "USB hub": 5 parts')
  })

  test("checks data flow between blocks", async () => {
    const { call } = setup("board")
    const bad = await call("odb_explore_submit_board", { ...boardResult, dataFlow: [{ from: "USB", to: "usb", via: "x" }, { from: "MCU", to: "Power", via: "x" }] }, EXPLORE_AGENT)
    expect(bad).toContain("both ends are the same block")
    expect(bad).toContain("Power is not a block")
    expect(await call("odb_explore_submit_board", boardResult, EXPLORE_AGENT)).toContain("Blocks without a saved result: USB, MCU")
    expect(await call("odb_understanding", {})).toContain("MCU -> USB via I2C_SDA/I2C_SCL: hub configuration")
  })

  test("goes stale when the schematic changes", async () => {
    const { dir, call } = setup("stale")
    await call("odb_explore_submit_block", usbBlock, BLOCK_AGENT)
    expect(await call("odb_understanding", { block: "USB" })).toStartWith("# Block USB\n")
    writeFileSync(join(dir, "fixture.schematic.md"), "# USB sheet")
    const after = await call("odb_understanding", { block: "USB" })
    expect(after).toStartWith("# Block USB [stale: schematic changed]")
    expect(after).toContain("fixture.schematic.md (1 KiB, text)")
  })

  test("a correction is recorded, moves parts and constrains rewrites", async () => {
    const { dir, call } = setup("fix")
    await call("odb_explore_submit_block", usbBlock, BLOCK_AGENT)
    await call("odb_explore_submit_board", boardResult, EXPLORE_AGENT)

    const res = await call("odb_understanding_correct", { block: "usb", title: "USB 2.0 hub, upstream only", removeParts: ["J1"], note: "J1 is a debug header, not part of the hub" }, FIX_AGENT)
    expect(res).toContain("under block USB")
    expect(res).toContain("Cached results to rewrite: block USB")
    expect(readFileSync(join(dir, "fixture.understanding.md"), "utf8")).toBe(
      "## Block USB\ntitle: USB 2.0 hub, upstream only\nparts: -J1\n- J1 is a debug header, not part of the hub\n",
    )

    // J1 left the block, so the old result is stale and may not name J1 again.
    expect(await call("odb_block", { block: "USB" })).not.toContain("J1 ")
    expect(await call("odb_understanding", {})).toContain('- USB "USB 2.0 hub, upstream only": Four-port USB 2.0 hub behind the connector. user-corrected [stale: block members changed]')
    expect(await call("odb_explore_submit_block", usbBlock, FIX_AGENT)).toContain("the user removed J1 from USB")
    const rewritten = await call("odb_explore_submit_block", { ...usbBlock, keyParts: [{ refdes: "U2", role: "hub controller" }] }, FIX_AGENT)
    expect(rewritten).toContain("Block USB saved.")
    expect(rewritten).toContain("The user set title for USB")
    const shown = await call("odb_understanding", {})
    expect(shown).toContain('- USB "USB 2.0 hub, upstream only": Four-port USB 2.0 hub behind the connector. user-corrected\n')
    expect(await call("odb_understanding", { mentions: "U2" })).toBe("Saved results mentioning U2:\n- block USB")
  })

  test("reset drops agent results, never the corrections file", async () => {
    const { dir, call } = setup("reset")
    await call("odb_explore_submit_block", usbBlock, BLOCK_AGENT)
    await call("odb_understanding_correct", { note: "Test board" }, FIX_AGENT)
    await call("odb_understanding", { action: "reset" })
    expect(await call("odb_understanding", {})).toContain("- USB: 5 parts")
    expect(readFileSync(join(dir, "fixture.understanding.md"), "utf8")).toBe("# Board\n- Test board\n")
  })
})

describe("agent registration", () => {
  const opts = { maxSubagents: 12 }

  test("registers three subagents with their write permissions", () => {
    const config: Record<string, any> = {}
    applyExploreConfig(config, opts)
    for (const name of [EXPLORE_AGENT, BLOCK_AGENT, FIX_AGENT]) {
      expect(config.agent[name].mode).toBe("subagent")
      expect(config.agent[name].hidden).toBeUndefined()
      expect(config.agent[name].permission.edit).toBe("deny")
    }
    expect(config.agent[EXPLORE_AGENT].permission.task).toEqual({ "*": "deny", [BLOCK_AGENT]: "allow" })
    expect(config.agent[EXPLORE_AGENT].prompt).toContain("at most 12 subagents")
    expect(config.agent[BLOCK_AGENT].permission).toMatchObject({ odb_explore_submit_block: "allow", odb_explore_submit_board: "deny", odb_understanding_correct: "deny" })
    expect(config.agent[FIX_AGENT].permission).toMatchObject({ odb_explore_submit_block: "allow", odb_explore_submit_board: "allow", odb_understanding_correct: "allow" })
    expect(config.agent[FIX_AGENT].permission.task).toBeUndefined()
    expect(config.agent[FIX_AGENT].description).toContain("MUST be launched")
  })

  test("denies the write tools to everyone else, after a user's catch-all", () => {
    const config: Record<string, any> = { permission: { "*": "allow", bash: "ask" } }
    applyExploreConfig(config, opts)
    expect(Object.entries(config.permission)).toEqual([
      ["*", "allow"],
      ["bash", "ask"],
      ["odb_explore_submit_block", "deny"],
      ["odb_explore_submit_board", "deny"],
      ["odb_understanding_correct", "deny"],
    ])
    const flat: Record<string, any> = { permission: "ask" }
    applyExploreConfig(flat, opts)
    expect(flat.permission["*"]).toBe("ask")
  })

  test("allows nested subagents unless the user set a depth", () => {
    const unset: Record<string, any> = {}
    applyExploreConfig(unset, opts)
    expect(unset.subagent_depth).toBe(2)
    const pinned: Record<string, any> = { subagent_depth: 1 }
    applyExploreConfig(pinned, opts)
    expect(pinned.subagent_depth).toBe(1)
  })

  test("user settings for an agent win", () => {
    const config: Record<string, any> = { agent: { [BLOCK_AGENT]: { model: "x/y", permission: { bash: "allow" } } } }
    applyExploreConfig(config, opts)
    expect(config.agent[BLOCK_AGENT]).toMatchObject({ model: "x/y", permission: { bash: "allow", edit: "deny", odb_explore_submit_block: "allow" } })
  })
})
