// Runs against a live OdbDesignServer that has testdata/jetson-orin-baseboard.tgz
// in its designs directory:  ODB_SERVER_URL=http://localhost:8888 bun test
import { describe, expect, test } from "bun:test"
import { OdbDesignClient } from "../src/client.ts"
import { DesignStore } from "../src/store.ts"

const url = process.env.ODB_SERVER_URL
const DESIGN = "jetson-orin-baseboard"

describe.skipIf(!url)("jetson-orin-baseboard via OdbDesignServer", () => {
  const store = new DesignStore(new OdbDesignClient({ baseUrl: url ?? "" }), DESIGN)

  test("loads the full board", async () => {
    const board = await store.get()
    expect(board.components.size).toBeGreaterThan(600)
    expect(board.nets.size).toBe(800)
  }, 60_000)

  test("attaches KiCad properties from the component layers", async () => {
    const board = await store.get()
    const u10 = board.findComponent("U10")!
    expect(board.mpn(u10)).toBe("TUSB1046-DCIRNQT")
    expect(board.datasheet(u10)).toStartWith("https://")
  })

  test("+5V lists its loads", async () => {
    const board = await store.get()
    const refs = board.nets.get("+5V")!.pins.map((p) => p.refDes)
    expect(refs).toContain("U17")
    expect(board.isRail("+5V")).toBe(true)
  })

  test("FTDI USB lines reach the connector through series resistors", async () => {
    const board = await store.get()
    const chains = board.signalPaths("U5", "J3").map((p) => p.map((s) => s.refDes).join(">"))
    expect(chains.sort()).toEqual(["U5>R117>J3", "U5>R127>J3"])
  })
})
