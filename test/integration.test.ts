// Parses testdata/jetson-orin-baseboard.tgz with the native OdbDesign
// binding. Skipped until native/build.sh has produced native/lib.
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { DesignStore } from "../src/store.ts"

const root = join(import.meta.dir, "..")
const built = existsSync(process.env.ODBPP_LIB ?? join(root, "native", "lib", "libodbpp.so"))

describe.skipIf(!built)("jetson-orin-baseboard via libodbpp", () => {
  const store = new DesignStore(join(root, "testdata"), "jetson-orin-baseboard")

  test("loads the full board", () => {
    const board = store.get()
    expect(board.components.size).toBeGreaterThan(600)
    expect(board.nets.size).toBe(800)
  }, 60_000)

  test("attaches KiCad properties, including values with spaces", () => {
    const board = store.get()
    const u10 = board.findComponent("U10")!
    expect(board.mpn(u10)).toBe("TUSB1046-DCIRNQT")
    expect(board.datasheet(u10)).toStartWith("https://")
    expect(board.findComponent("R287")!.properties.Manufacturer).toBe("ROHM Semiconductor")
  })

  test("+5V lists its loads", () => {
    const board = store.get()
    expect(board.nets.get("+5V")!.pins.map((p) => p.refDes)).toContain("U17")
    expect(board.isRail("+5V")).toBe(true)
  })

  test("FTDI USB lines reach the connector through series resistors", () => {
    const board = store.get()
    const chains = board.signalPaths("U5", "J3").map((p) => p.map((s) => s.refDes).join(">"))
    expect(chains.sort()).toEqual(["U5>R117>J3", "U5>R127>J3"])
  })

  test("finds the 48 test points and their nets in both directions", () => {
    const board = store.get()
    expect(board.testPoints()).toHaveLength(48)
    expect([...board.findComponent("TP21")!.pins.values()]).toEqual(["DP1_HPD"])
    expect(board.testPoints({ net: "DP1_HPD" }).map((c) => c.refDes)).toEqual(["TP21"])
  })

  test("leaves the designs directory untouched", () => {
    expect(existsSync(join(root, "testdata", "jetson-orin-baseboard"))).toBe(false)
  })
})
