import { describe, expect, test } from "bun:test"
import { BoardIndex } from "../src/board.ts"
import { blockDetail, interfacesDetail, overviewDetail } from "../src/format.ts"
import { classifyBusNet, detectInterfaces, findBlock, groupBlocks } from "../src/overview.ts"
import type { NativeBoard, NativeNet } from "../src/native.ts"

/** Nets as name -> pins "REF.PIN"; unused anchor pins go to $NONE$ so the parts have >= 8 pins. */
function boardOf(nets: Record<string, string[]>, comps: NativeBoard["components"]): BoardIndex {
  const native: NativeNet[] = Object.entries(nets).map(([name, pins]) => ({
    name,
    pins: pins.map((p) => p.split(".") as [string, string]),
  }))
  const pad: [string, string][] = []
  for (const c of comps) if (/^(U|J)/.test(c.refDes)) for (let i = 1; i <= 8; i++) pad.push([c.refDes, `nc${i}`])
  native.push({ name: "$NONE$", pins: pad })
  return BoardIndex.build({ name: "fixture", components: comps, nets: native })
}

// KiCad-like: an MCU sheet and a USB sheet, each with an IC, support parts and
// a decoupling cap that only touches rails.
const kicad = boardOf(
  {
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
  },
  [
    { refDes: "U1", props: { Value: "STM32G0" }, x: 0, y: 0 },
    { refDes: "U2", props: { Value: "USB2514" }, x: 50, y: 0 },
    { refDes: "J1", x: 60, y: 0 },
    { refDes: "Y1", x: 2, y: 0 },
    { refDes: "R1", x: 55, y: 0 },
    { refDes: "R2", x: 55, y: 1 },
    { refDes: "R3", x: 25, y: 0 },
    { refDes: "C1", x: 1, y: 1 },
    { refDes: "C2", x: 49, y: 1 },
    { refDes: "MH1" },
  ],
)

describe("groupBlocks", () => {
  test("uses KiCad sheet names and places the rest by connectivity and proximity", () => {
    const g = groupBlocks(kicad)
    expect(g.source).toBe("sheet")
    expect(g.blocks.map((b) => b.name).sort()).toEqual(["MCU", "USB"])
    expect(findBlock(g, "usb")!.members).toEqual(["C2", "J1", "R1", "R2", "U2"])
    // R3 pulls I2C_SDA up; U1 and U2 tie for it and the first vote wins
    expect(findBlock(g, "MCU")!.members).toEqual(["C1", "R3", "U1", "Y1"])
    expect(g.placement.get("J1")).toBe("connectivity")
    expect(g.placement.get("C1")).toBe("proximity")
    expect(g.blockOf.has("MH1")).toBe(false)
  })

  test("finds a block by member refdes", () => {
    expect(findBlock(groupBlocks(kicad), "R1")!.name).toBe("USB")
  })

  test("reports the nets between blocks", () => {
    const usb = findBlock(groupBlocks(kicad), "USB")!
    expect(usb.boundary.map((b) => b.net)).toContain("I2C_SCL")
    expect(usb.rails).toEqual([{ net: "+3V3", parts: 2 }])
  })

  test("uses per-sheet refdes numbering when net names are flat", () => {
    const comps: NativeBoard["components"] = []
    const nets: Record<string, string[]> = {}
    for (const sheet of [1, 2, 3]) {
      for (let i = 1; i <= 8; i++) {
        const r = `R${sheet}0${i.toString().padStart(2, "0")}`
        comps.push({ refDes: r })
        nets[`N${r}`] = [`${r}.1`, `U${sheet}001.${i}`]
      }
      comps.push({ refDes: `U${sheet}001` })
    }
    const g = groupBlocks(boardOf(nets, comps))
    expect(g.source).toBe("refdesBand")
    expect(g.blocks.map((b) => b.name).sort()).toEqual(["1xxx", "2xxx", "3xxx"])
    expect(g.blocks.every((b) => b.members.length === 9)).toBe(true)
  })

  test("falls back to clusters around large parts", () => {
    const g = groupBlocks(
      boardOf(
        { A: ["U1.1", "R1.1"], B: ["R1.2", "R2.1"], C: ["U2.1", "R3.1"], D: ["U1.2", "U2.2"] },
        [{ refDes: "U1" }, { refDes: "U2" }, { refDes: "R1" }, { refDes: "R2" }, { refDes: "R3" }],
      ),
    )
    expect(g.source).toBe("cluster")
    expect(findBlock(g, "U1")!.members).toEqual(["R1", "R2", "U1"])
    expect(findBlock(g, "U2")!.members).toEqual(["R3", "U2"])
  })
})

describe("interfaces", () => {
  test("classifies nets by bus name or signal role", () => {
    expect(classifyBusNet("CSI0_D0_N")).toEqual({ kind: "MIPI CSI/DSI", name: "CSI0" })
    expect(classifyBusNet("GPIOEX_I2C_SCL")).toEqual({ kind: "I2C", name: "GPIOEX_I2C" })
    expect(classifyBusNet("SYS_SCL")).toEqual({ kind: "I2C", name: "SYS" })
    expect(classifyBusNet("SDA")).toEqual({ kind: "I2C", name: "I2C" })
    expect(classifyBusNet("~{SPI0_CS0}")).toEqual({ kind: "SPI", name: "SPI0" })
    expect(classifyBusNet("FMU-I2C1_SDA")).toEqual({ kind: "I2C", name: "FMU_I2C1" })
    expect(classifyBusNet("CSIA_I2C_VCC")).toBeUndefined()
    expect(classifyBusNet("unconnected-(J1-SDIO_CLK-Pad9)")).toBeUndefined()
    expect(classifyBusNet("NetR7012_P$1")).toBeUndefined()
    expect(classifyBusNet("LED_STATUS")).toBeUndefined()
  })

  test("finds buses, diff pairs, ends through series parts and pull-ups", () => {
    const buses = detectInterfaces(kicad)
    const usb = buses.find((b) => b.kind === "USB")!
    expect(usb.nets).toEqual(["/USB/USB_D_N", "/USB/USB_D_P", "USB_CONN_D_N", "USB_CONN_D_P"])
    expect(usb.diffPairs).toBe(2)
    expect(usb.endpoints).toEqual(["J1", "U2"])
    expect(usb.series).toEqual(["R1", "R2"])
    const i2c = buses.find((b) => b.kind === "I2C")!
    expect(i2c.endpoints).toEqual(["U1", "U2"])
    expect(i2c.pulls).toEqual(["R3"])
  })
})

describe("renderers", () => {
  test("overview, block and interfaces render", () => {
    const g = groupBlocks(kicad)
    const buses = detectInterfaces(kicad)
    const ov = overviewDetail(kicad, g, buses)
    expect(ov).toContain("## Blocks (2), inferred from schematic sheet names")
    expect(ov).toContain("- USB: 5 parts | U2 USB2514; J1")
    expect(ov).toContain("- USB: 1 buses, 4 nets: USB")
    expect(blockDetail(kicad, g, findBlock(g, "MCU")!)).toContain("U1 STM32G0 | 14 pins")
    expect(interfacesDetail(kicad, buses, g)).toContain("ends: J1, U2 USB2514")
  })
})
