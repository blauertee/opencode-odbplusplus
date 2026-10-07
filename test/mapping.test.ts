import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BoardIndex } from "../src/board.ts"
import { componentDetail } from "../src/format.ts"
import type { AgentRunner } from "../src/mapping/agent.ts"
import { mappingHealth } from "../src/mapping/health.ts"
import { checkMpn, mpnInText } from "../src/mapping/mpn.ts"
import { applyMapping, MappingCache } from "../src/mapping/overlay.ts"
import { mergeMappings } from "../src/mapping/rules.ts"
import type { MappingOutput, MappingRule } from "../src/mapping/schema.ts"
import { MappingService } from "../src/mapping/service.ts"
import { validateOutput } from "../src/mapping/validate.ts"
import type { NativeBoard } from "../src/native.ts"
import { DesignStore } from "../src/store.ts"

const tmp = mkdtempSync(join(tmpdir(), "odb-mapping-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const ev = { note: "test" }

/** n components with one property each, on their own signal nets plus GND. */
function boardWith(n: number, props: (i: number) => Record<string, string>, extra: Partial<NativeBoard> = {}): NativeBoard {
  const components = Array.from({ length: n }, (_, i) => ({ refDes: `U${i + 1}`, package: "SOT-23-6", props: props(i) }))
  const nets = [
    { name: "GND", pins: components.map((c) => [c.refDes, "2"] as [string, string]) },
    ...components.map((c, i) => ({ name: `SIG${i}`, pins: [[c.refDes, "1"]] as [string, string][] })),
  ]
  return { name: "fixture", components: [...components, ...(extra.components ?? [])], nets: [...nets, ...(extra.nets ?? [])] }
}

describe("MPN checks", () => {
  const verdict = (v: string, ctx = {}) => checkMpn(v, ctx).verdict

  test("rejects values, distributor numbers and library names", () => {
    for (const v of ["220R", "100nF", "10u/25V", "296-1234-1-ND", "C25804", "https://x/y.pdf", "LED0603_Green", "MMBT3906*SMD", "DIODE-TVS"]) {
      expect(verdict(v)).toBe("reject")
    }
    expect(verdict("SOT-23-6", { package: "SOT-23-6" })).toBe("reject")
  })

  test("keeps real part numbers that look odd", () => {
    for (const v of ["5031820852", "2-1734839-1", "DF40C-20-DS", "1N4148W", "MS5611-01BA"]) expect(verdict(v)).toBe("unverified")
  })

  test("checks family grammars against the footprint", () => {
    expect(verdict("GRM155R71C104KA88D", { package: "C_0402_1005Metric" })).toBe("verified")
    expect(verdict("GRM155R71C104KA88D", { package: "C_0603_1608Metric" })).toBe("reject")
    expect(verdict("ERJ2GE0R00X", { package: "R_0402_1005Metric" })).toBe("verified")
    expect(verdict("STM32F427VIT6", { pins: 100 })).toBe("verified")
    expect(verdict("STM32F427VIT6", { pins: 64 })).toBe("reject")
    expect(verdict("STM32F4X7VX_100_pin")).toBe("reject")
  })

  test("finds an MPN in datasheet text, also without its packaging suffix", () => {
    expect(mpnInText("TPS62100DRLR", "Ordering: TPS62100DRL  SOT-563")).toBe(true)
    expect(mpnInText("TPS62100DRLR", "TPS62200 family")).toBe(false)
  })
})

describe("health check", () => {
  test("flags an unknown property that carries MPNs", () => {
    const b = BoardIndex.build(boardWith(10, (i) => ({ Value: `TPS6210${i}`, Herstellerteilenummer: `TPS6210${i}DRLR` })))
    const h = mappingHealth(b)
    expect(h.gaps.find((g) => g.signal === "S1")?.candidates).toEqual(["Herstellerteilenummer"])
    expect(h.launch).toBe(true)
  })

  test("flags distributor numbers read as MPN", () => {
    const b = BoardIndex.build(boardWith(10, (i) => ({ Value: "x", "Part Number": `296-12${i}4-1-ND` })))
    expect(mappingHealth(b).gaps.map((g) => g.signal)).toContain("S5")
  })

  test("a fully mapped board does not launch", () => {
    const b = BoardIndex.build(boardWith(10, (i) => ({ Value: `TPS6210${i}`, MPN: `TPS6210${i}DRLR`, Datasheet: "https://ti.com/x.pdf" })))
    expect(mappingHealth(b).launch).toBe(false)
  })
})

describe("mapping rules", () => {
  const native = boardWith(6, (i) => ({ "Part Number": `INT-${i}`, MFGPN: `TPS6210${i}DRLR`, Hersteller: "TI" }), {
    components: [{ refDes: "FMU-SWCLK", part: "PAD.04" }],
    nets: [{ name: "SWCLK", pins: [["FMU-SWCLK", "1"]] }],
  })

  test("aliases, ignores and classifications change how properties are read, not the properties", () => {
    const b = BoardIndex.build(native)
    expect(b.mpn(b.findComponent("U1")!)).toBe("TPS62100DRLR") // MFGPN comes before Part Number
    b.mapping = mergeMappings([
      {
        output: {
          rules: [
            { kind: "propertyAlias", field: "manufacturer", property: "Hersteller", confidence: "high", evidence: ev },
            { kind: "ignoreProperty", property: "MFGPN", reason: "unrelated", confidence: "high", evidence: ev },
            { kind: "classify", feature: "testPoint", value: true, match: { part: ["PAD.04"] }, confidence: "high", evidence: ev },
          ],
        },
      },
    ])
    const u1 = b.findComponent("U1")!
    expect(b.manufacturer(u1)).toBe("TI")
    expect(b.mpn(u1)).toBe("INT-0")
    expect(u1.properties.MFGPN).toBe("TPS62100DRLR")
    expect(b.testPoints().map((c) => c.refDes)).toEqual(["FMU-SWCLK"])
  })

  test("validator rejects rules the data does not support", async () => {
    const b = BoardIndex.build(native)
    const rules: MappingRule[] = [
      { kind: "propertyAlias", field: "mpn", property: "Nope", confidence: "high", evidence: ev },
      { kind: "componentValue", refDes: "U99", field: "value", value: "x", source: { kind: "inferred" }, confidence: "low", evidence: ev },
      { kind: "componentValue", refDes: "U1", field: "mpn", value: "TPS99", source: { kind: "property", property: "MFGPN" }, confidence: "high", evidence: ev },
      { kind: "componentValue", refDes: "U1", field: "value", value: "TPS", source: { kind: "inferred" }, confidence: "high", evidence: ev },
      { kind: "componentValue", refDes: "U1", field: "datasheet", value: "https://made.up/x.pdf", source: { kind: "inferred" }, confidence: "low", evidence: ev },
      { kind: "classify", feature: "testPoint", value: true, match: { refdesPattern: "^U" }, confidence: "high", evidence: ev },
      { kind: "propertyAlias", field: "mpn", property: "Part Number", confidence: "high", evidence: ev },
      { kind: "classify", feature: "testPoint", value: true, match: { refdes: ["FMU-SWCLK"] }, confidence: "high", evidence: ev },
    ]
    const v = await validateOutput(b, { rules })
    expect(v.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5])
    // "INT-0" passes tier 1 (it could be a real MPN), so the alias stays, unverified
    expect(v.accepted.map((r) => r.kind)).toEqual(["propertyAlias", "classify"])
    expect(v.mpnStatus["U1:INT-0"]).toBe(false)
  })

  test("user overrides win over agent rules", async () => {
    const b = BoardIndex.build(native)
    const user: MappingRule[] = [{ kind: "ignoreProperty", property: "Hersteller", reason: "unrelated", confidence: "high", evidence: ev }]
    const v = await validateOutput(
      b,
      { rules: [{ kind: "propertyAlias", field: "manufacturer", property: "Hersteller", confidence: "high", evidence: ev }] },
      { userOverrides: { rules: user } },
    )
    expect(v.rejected[0].reason).toContain("override")
  })
})

describe("mapping service", () => {
  const designs = join(tmp, "designs")
  const archive = join(designs, "fixture.tgz")
  const native = boardWith(8, (i) => ({ Value: `TPS6210${i}`, Herstellerteilenummer: `TPS6210${i}DRLR` }))
  const output: MappingOutput = {
    rules: [{ kind: "propertyAlias", field: "mpn", property: "Herstellerteilenummer", confidence: "high", evidence: ev }],
    unresolved: [{ target: "datasheet", reason: "absent-in-export", detail: "no links" }],
    summary: "MPNs come from Herstellerteilenummer.",
  }
  let runs = 0
  const fake: AgentRunner = {
    async run(req) {
      runs++
      expect(req.input.gaps.some((g) => g.signal === "S1")).toBe(true)
      return { output, validation: await req.validate(output), submits: 1 }
    },
  }
  const service = (cache: MappingCache) => new MappingService({ cache, designsDir: designs, agent: fake, mode: "auto", waitMs: 1000 })

  test("repairs once, stores the overlay outside the archive and reuses it", async () => {
    require("node:fs").mkdirSync(designs, { recursive: true })
    writeFileSync(archive, "not a real archive, the loader is faked")
    const before = createHash("sha256").update(readFileSync(archive)).digest("hex")
    const cache = new MappingCache(join(tmp, "cache"))

    const store = new DesignStore(designs, undefined, () => native, service(cache))
    const { board } = await store.open(undefined, { waitFor: ["mpn"] })
    expect(runs).toBe(1)
    expect(board.mpn(board.findComponent("U3")!)).toBe("TPS62102DRLR")
    expect(store.handle().health.launch).toBe(false)
    expect(cache.read(before)?.output.rules).toHaveLength(1)
    expect(cache.conventions().map((r) => r.kind)).toEqual(["propertyAlias"])
    expect(createHash("sha256").update(readFileSync(archive)).digest("hex")).toBe(before)

    // A new process: overlay applies from the cache, no second run.
    const again = new DesignStore(designs, undefined, () => native, service(cache))
    const reopened = await again.open(undefined, { waitFor: ["mpn"] })
    expect(runs).toBe(1)
    expect(reopened.board.mpn(reopened.board.findComponent("U3")!)).toBe("TPS62102DRLR")
    expect(componentDetail(reopened.board, reopened.board.findComponent("U3")!, 5)).toContain("mpn: TPS62102DRLR (verified)")
  })

  test("user override file is read next to the archive", async () => {
    writeFileSync(
      join(designs, "fixture.mapping.json"),
      JSON.stringify({ rules: [{ kind: "componentValue", refDes: "U1", field: "mpn", value: "TPS62100DRLT", source: { kind: "inferred" }, confidence: "low", evidence: ev }] }),
    )
    const store = new DesignStore(designs, undefined, () => native, service(new MappingCache(join(tmp, "cache"))))
    const { board } = await store.open()
    expect(board.mpn(board.findComponent("U1")!)).toBe("TPS62100DRLT")
    rmSync(join(designs, "fixture.mapping.json"))
  })
})

// ---------------------------------------------------------------- real boards

const root = join(import.meta.dir, "..")
const built = existsSync(process.env.ODBPP_LIB ?? join(root, "native", "lib", "libodbpp.so"))

describe.skipIf(!built)("health and repair on the test boards", () => {
  test("the KiCad Jetson board needs no repair", () => {
    const h = mappingHealth(new DesignStore(join(root, "testdata")).get("jetson-orin-baseboard"))
    expect(h.launch).toBe(false)
    expect(h.testPoints).toBe(48)
  }, 60_000)

  test("the Altium Pixhawk export gets repaired", async () => {
    const archive = join(root, "testdata", "altium.pixhawk-fmuv3.tgz")
    const before = createHash("sha256").update(readFileSync(archive)).digest("hex")
    const board = new DesignStore(join(root, "testdata")).get("altium.pixhawk-fmuv3")
    const h = mappingHealth(board)
    expect(h.gaps.map((g) => g.signal)).toEqual(["S2", "S2", "S3", "S4"])
    expect(h.launch).toBe(true)

    const proposal: MappingOutput = {
      rules: [
        { kind: "partNameAs", field: "value", scope: { refdesPrefixes: ["R", "C", "L", "RN", "F", "LED"] }, confidence: "high", evidence: ev },
        // Too broad: the Comments of several ICs are library names, so the whole rule is refused ...
        { kind: "partNameAs", field: "mpn", scope: { refdesPrefixes: ["U", "D", "Q", "X"] }, confidence: "medium", evidence: ev },
        // ... while the parts whose part name is an orderable number pass.
        { kind: "partNameAs", field: "mpn", scope: { refdes: ["U10001", "D10001", "U4002", "U4001"] }, confidence: "medium", evidence: ev },
        { kind: "classify", feature: "testPoint", value: true, match: { part: ["PAD.04"] }, confidence: "high", evidence: ev },
        { kind: "classify", feature: "mechanical", value: true, match: { part: ["MOUNT-HOLE1.8MM"] }, confidence: "high", evidence: ev },
      ],
      unresolved: [],
      summary: "",
    }
    const v = await validateOutput(board, proposal)
    expect(v.rejected.map((r) => r.index)).toEqual([1])
    expect(v.rejected[0].reason).toContain("STM32F4X7VX_100_pin")

    applyMapping(board, { overlay: { output: { rules: v.accepted }, mpnStatus: v.mpnStatus } as never })
    expect(board.testPoints().map((c) => c.refDes)).toEqual(["5v", "FMU-SWCLK", "FMU-SWDIO", "FMU-VDD_3V3", "IO-SWCLK", "IO-SWDIO", "IO-VDD_3V3", "RX5", "TX5"])
    expect(board.value(board.findComponent("R1022")!)).toBe("220R")
    expect(board.resolve(board.findComponent("U10001")!, "mpn")[0]).toMatchObject({ value: "BQ24313", inferred: true, verified: true })
    expect(board.mpn(board.findComponent("U1001")!)).toBeUndefined()
    expect(mappingHealth(board).gaps.map((g) => g.signal)).not.toContain("S3")
    expect(createHash("sha256").update(readFileSync(archive)).digest("hex")).toBe(before)
  }, 60_000)
})

describe("plugin wiring", () => {
  test("registers the agent and hides its tools from other agents", async () => {
    const { OdbPlusPlusPlugin } = await import("../src/index.ts")
    const hooks = await OdbPlusPlusPlugin({ client: {}, directory: tmp } as never, { designsDir: tmp, mappingDir: join(tmp, "wiring") })
    const config: Record<string, any> = { small_model: "anthropic/small", tools: { bash: true } }
    await hooks.config!(config as never)
    expect(config.agent["odb-mapper"]).toMatchObject({ mode: "subagent", model: "anthropic/small", tools: { "*": false, odb_mapping_submit: true, odb_component: true } })
    expect(config.tools).toMatchObject({ bash: true, odb_mapping_submit: false, odb_mapping_values: false, odb_mapping_profile: false })
    const result = await hooks.tool!.odb_mapping_submit.execute({ rules: [], unresolved: [], summary: "" } as never, { sessionID: "other" } as never)
    expect(String(result)).toContain("only available")
  })

  test("runs the agent in a child session and takes its submit as the result", async () => {
    const { OpencodeAgentRunner } = await import("../src/mapping/agent.ts")
    const board = BoardIndex.build(boardWith(8, (i) => ({ Value: `TPS6210${i}`, Herstellerteilenummer: `TPS6210${i}DRLR` })))
    const calls: string[] = []
    let runner: InstanceType<typeof OpencodeAgentRunner>
    // Stands in for OpenCode: the "model" first submits a bad rule, then a good one.
    const client = {
      session: {
        create: async (req: { body: { parentID?: string } }) => (calls.push(`create ${req.body.parentID}`), { data: { id: "ses_child" } }),
        prompt: async (req: { path: { id: string }; body: { agent: string; parts: { text: string }[] } }) => {
          calls.push(`prompt ${req.body.agent}`)
          const bad = { kind: "propertyAlias", field: "mpn", property: "Nope", confidence: "high", evidence: ev }
          const good = { kind: "propertyAlias", field: "mpn", property: "Herstellerteilenummer", confidence: "high", evidence: ev }
          calls.push((await runner.submit(req.path.id, { rules: [bad, good] as MappingRule[], unresolved: [], summary: "" })).split("\n")[0])
          calls.push((await runner.submit(req.path.id, { rules: [good] as MappingRule[], unresolved: [], summary: "ok" })).split("\n")[0])
          return { data: {} }
        },
        abort: async () => (calls.push("abort"), { data: true }),
      },
    }
    runner = new OpencodeAgentRunner(client as never, { timeoutMs: 5000 })
    const input = { design: { name: "fixture" } } as never
    const res = await runner.run({ board, input, parentID: "ses_parent", validate: (o) => validateOutput(board, o) })
    expect(calls).toEqual(["create ses_parent", "prompt odb-mapper", "Accepted 1 rules, rejected 1.", "Accepted 1 rules, rejected 0.", "abort"])
    expect(res).toMatchObject({ submits: 2, sessionID: "ses_child", output: { summary: "ok" } })
    expect(runner.state("ses_child")).toBeUndefined()
  })
})
