// Parses testdata/jetson-orin-baseboard.tgz with the native OdbDesign
// binding. Skipped until native/build.sh has produced native/lib.
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { detectInterfaces, findBlock, groupBlocks } from "../src/overview.ts"
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

  test("groups parts by the KiCad schematic sheets", () => {
    const g = groupBlocks(store.get())
    expect(g.source).toBe("sheet")
    expect(g.blocks.map((b) => b.name).sort()).toEqual(
      ["CSI", "Ethernet", "HDMI", "M.2", "Peripherals", "SoM", "Supply", "USB3", "USB_Debug,_DP"],
    )
    expect(g.unassigned.length).toBeLessThan(40)
    expect(findBlock(g, "Supply")!.anchors).toEqual(expect.arrayContaining(["U1", "U40", "U29", "U48"]))
    expect(findBlock(g, "U17")!.name).toBe("USB3")
  })

  test("finds the camera, Ethernet and I2C buses by net name", () => {
    const buses = detectInterfaces(store.get())
    const csi0 = buses.find((b) => b.name === "CSI0")!
    expect(csi0.kind).toBe("MIPI CSI/DSI")
    expect(csi0.diffPairs).toBeGreaterThanOrEqual(3)
    expect(buses.find((b) => b.name === "GBE")!.endpoints).toEqual(expect.arrayContaining(["J6", "J15"]))
    expect(buses.find((b) => b.name === "GPIOEX_I2C")!.series).toEqual(["R215", "R216"])
  })

  test("leaves the designs directory untouched", () => {
    expect(existsSync(join(root, "testdata", "jetson-orin-baseboard"))).toBe(false)
  })
})

// Altium Designer 20.1 export; Altium writes no misc/info file.
describe.skipIf(!built)("altium.pixhawk-fmuv3 via libodbpp", () => {
  const store = new DesignStore(join(root, "testdata"), "altium.pixhawk-fmuv3")

  test("loads without a misc/info file", () => {
    const board = store.get()
    expect(board.components.size).toBe(166)
    expect(board.nets.size).toBe(249)
  }, 60_000)

  test("carries the Altium comment as part name and no properties", () => {
    const board = store.get()
    const u1001 = board.findComponent("U1001")!
    expect(u1001.part).toBe("STM32F4X7VX_100_pin")
    expect(board.findComponent("R1022")!.part).toBe("220R")
    expect(board.mpn(u1001)).toBeUndefined()
    expect(board.search("STM32").components.map((c) => c.refDes).sort()).toEqual(["U1001", "U7001"])
  })

  test("groups parts by the per-sheet refdes numbering", () => {
    const g = groupBlocks(store.get())
    expect(g.source).toBe("refdesBand")
    expect(g.blocks).toHaveLength(10)
    expect(findBlock(g, "4xxx")!.anchors.sort()).toEqual(["U4001", "U4002", "U4003"])
  })

  test("finds the CAN buses through the transceivers", () => {
    const buses = detectInterfaces(store.get())
    expect(buses.find((b) => b.name === "CAN1")!.endpoints).toEqual(["U1001", "U3004"])
  })

  test("IMU reaches the MCU directly", () => {
    const board = store.get()
    expect(board.signalPaths("U4001", "U1001").every((p) => p.map((s) => s.refDes).join(">") === "U4001>U1001")).toBe(true)
  })
})
