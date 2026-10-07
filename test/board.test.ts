import { describe, expect, test } from "bun:test"
import { normalizePropertyName, PROPERTY_ALIASES } from "../src/aliases.ts"
import { BoardIndex } from "../src/board.ts"
import { extractSection } from "../src/datasheet.ts"
import { testPointLine } from "../src/format.ts"
import type { NativeBoard } from "../src/native.ts"

// Tiny board: MCU U1 drives a connector J1 through a series resistor R1 and
// talks to U2 directly; both ICs sit on +5V and GND, decoupled by C1.
const fixture: NativeBoard = {
  name: "tiny",
  components: [
    { refDes: "U1", props: { Value: "STM32G0", MPN: "STM32G031K8T6" } },
    { refDes: "U2" },
    { refDes: "R1", props: { Value: "33R" } },
    { refDes: "C1" },
    { refDes: "J1" },
  ],
  nets: [
    { name: "+5V", pins: [["U1", "1"], ["U2", "1"], ["C1", "1"]] },
    { name: "GND", pins: [["U1", "2"], ["U2", "2"], ["C1", "2"], ["J1", "2"]] },
    { name: "/IO/UART_TX", pins: [["U1", "3"], ["R1", "1"]] },
    { name: "/IO/UART_TX_CONN", pins: [["R1", "2"], ["J1", "1"]] },
    { name: "SPI_CLK", pins: [["U1", "4"], ["U2", "3"]] },
    { name: "$NONE$", pins: [["U2", "4"]] },
  ],
}
const board = BoardIndex.build(fixture)

describe("BoardIndex", () => {
  test("maps pins to nets", () => {
    expect(board.findComponent("u1")?.pins.get("3")).toBe("/IO/UART_TX")
    expect(board.findComponent("U2")?.pins.get("4")).toBe("$NONE$")
  })

  test("resolves hierarchical net names by leaf", () => {
    expect(board.findNets("UART_TX").map((n) => n.name)).toEqual(["/IO/UART_TX"])
    expect(board.findNets("+5v").map((n) => n.name)).toEqual(["+5V"])
  })

  test("detects rails by name", () => {
    expect(board.isRail("+5V")).toBe(true)
    expect(board.isRail("GND")).toBe(true)
    expect(board.isRail("/IO/UART_TX")).toBe(false)
  })

  test("reads properties case-insensitively", () => {
    const u1 = board.findComponent("U1")!
    expect(board.value(u1)).toBe("STM32G0")
    expect(board.mpn(u1)).toBe("STM32G031K8T6")
  })

  test("finds the chain through the series resistor, not via rails", () => {
    const paths = board.signalPaths("U1", "J1")
    expect(paths).toHaveLength(1)
    expect(paths[0].map((s) => s.refDes)).toEqual(["U1", "R1", "J1"])
    expect(paths[0][0].via).toBe("/IO/UART_TX")
  })

  test("does not route through large parts by default", () => {
    // J1 -> U2 would need to pass through U1 (4 pins) - allowed at 4, blocked at 3
    expect(board.signalPaths("J1", "U2", { maxPinsThrough: 3 })).toEqual([])
    expect(board.signalPaths("J1", "U2", { maxPinsThrough: 4 })[0].map((s) => s.refDes)).toEqual(["J1", "R1", "U1", "U2"])
  })

  test("search matches values and nets", () => {
    const r = board.search("stm32")
    expect(r.components.map((c) => c.refDes)).toEqual(["U1"])
    expect(board.search("UART").nets.map((n) => n.name)).toEqual(["/IO/UART_TX", "/IO/UART_TX_CONN"])
  })
})

describe("test points", () => {
  const tpBoard = BoardIndex.build({
    name: "tp",
    components: [
      { refDes: "U1", package: "QFN-32" },
      { refDes: "TP1", package: "TP_SMD_0.75mm", side: "Bottom", x: 10, y: -5 },
      { refDes: "TP2", side: "Top" },
      { refDes: "X7", package: "TestPoint_Pad_D1.0mm" },
      { refDes: "U9", props: { Value: "TPS62130" } },
      { refDes: "R3", props: { Value: "10k" } },
      { refDes: "T1", package: "TEST_PAD" },
    ],
    nets: [
      { name: "/I2C/SDA", pins: [["U1", "1"], ["TP1", "1"], ["X7", "1"], ["R3", "1"], ["T1", "1"]] },
      { name: "GND", pins: [["U1", "2"], ["TP2", "1"], ["U9", "1"], ["R3", "2"]] },
      { name: "SW", pins: [["U9", "2"]] },
    ],
  })
  const refs = (cs: { refDes: string }[]) => cs.map((c) => c.refDes)

  test("recognises TP refdes and TP/TestPoint footprints, not TPS parts", () => {
    expect(refs(tpBoard.testPoints())).toEqual(["TP1", "TP2", "X7"])
  })

  test("lists the test points on one net", () => {
    expect(refs(tpBoard.testPoints({ net: "/I2C/SDA" }))).toEqual(["TP1", "X7"])
    expect(refs(tpBoard.testPoints({ net: "SW" }))).toEqual([])
  })

  test("a refdes pattern replaces the default rule", () => {
    expect(refs(tpBoard.testPoints({ pattern: /^T\d/ }))).toEqual(["T1"])
  })

  test("parts with more than two pins are never test points by default", () => {
    expect(tpBoard.isTestPoint(tpBoard.findComponent("U1")!)).toBe(false)
  })

  test("formats net, side and position", () => {
    expect(testPointLine(tpBoard.findComponent("TP1")!)).toBe("TP1 | /I2C/SDA | Bottom | at 10, -5")
  })
})

describe("extractSection", () => {
  const text = [
    "Table of Contents",
    "1 Features ............................ 1",
    "3 Description ......................... 1",
    "",
    "1 Features",
    "  • Fast",
    "3 Description",
    "  The part is a USB-C redriver.",
    "  It has four channels.",
    "4 Pin Configuration",
    "  Pin 1 is VCC",
  ].join("\n")

  test("skips the table of contents and stops at the next chapter", () => {
    const s = extractSection(text, "Description")!
    expect(s).toContain("USB-C redriver")
    expect(s).toContain("four channels")
    expect(s).not.toContain("Pin 1")
    expect(s).not.toContain(".....")
  })

  test("returns undefined for unknown sections", () => {
    expect(extractSection(text, "Ordering Information")).toBeUndefined()
  })
})

describe("property aliases", () => {
  const aliased = BoardIndex.build({
    name: "aliases",
    components: [
      { refDes: "U1", props: { MFGPN: "MPU-6000", DATASHEET: "https://example.com/mpu6000.pdf" } },
      { refDes: "U2", props: { Manufacturer_Part_Number: "TPS7A02", "Part Number": "INT-0042" } },
      { refDes: "U3", props: { HelpURL: "\\\\server\\ds\\x.pdf", ComponentLink1URL: "https://example.com/x.pdf" } },
      { refDes: "U4", props: { "Part Number (MPN)": "LM2596S-5.0", Value: "~", Val: "5V" } },
    ],
    nets: [],
  })
  const get = (r: string) => aliased.findComponent(r)!

  test("matches names regardless of case, spaces and separators", () => {
    expect(aliased.mpn(get("U1"))).toBe("MPU-6000")
    expect(aliased.mpn(get("U4"))).toBe("LM2596S-5.0")
    expect(aliased.datasheet(get("U1"))).toBe("https://example.com/mpu6000.pdf")
  })

  test("prefers specific names over generic ones", () => {
    expect(aliased.mpn(get("U2"))).toBe("TPS7A02")
  })

  test("prefers a downloadable datasheet link over a network path", () => {
    expect(aliased.datasheet(get("U3"))).toBe("https://example.com/x.pdf")
  })

  test("skips KiCad's empty marker", () => {
    expect(aliased.value(get("U4"))).toBe("5V")
  })

  test("no two aliases collapse to the same name", () => {
    const all = Object.values(PROPERTY_ALIASES).flat().map(normalizePropertyName)
    expect(new Set(all).size).toBe(all.length)
  })
})
