# Board overview: blocks and interfaces

The component, net and path tools answer precise questions, but they do not tell an agent what a board
is and does. A human gets that from the schematic: sheets per function, parts grouped around the IC they
serve, buses drawn as one line. ODB++ does not carry any of that. It has no sheets, hierarchy or net
classes, and the KiCad and Altium exports we have do not use its attributes or feature groups for it.

This feature infers the structure from what does survive the export and exposes it through three tools:
`odb_overview`, `odb_block` and `odb_interfaces`.

Code: `src/overview.ts` (grouping, bus detection), renderers in `src/format.ts`, tools in `src/tools.ts`.
Tests: `test/overview.test.ts` (fixtures), `test/integration.test.ts` (both test boards).

## Blocks

`groupBlocks(board)` assigns every non-mechanical part to a block in four passes.

### 1. Seeds, from the first source that applies

| Source | Signal | Used when | Block names |
|---|---|---|---|
| `sheet` | KiCad prefixes local nets with the sheet path (`/USB3/USB_SS_TX_P`). Each part votes the sheet of its nets. | at least two sheets, and at least 15% of the parts get a vote | sheet path, e.g. `USB3` |
| `refdesBand` | Per-sheet annotation numbers parts by sheet (`R7012`, `C5101`). | at least 80% of the numbered parts are >= 1000 (or >= 100), there are 2 to 60 bands and most bands restart their counter | `7xxx` (or `7xx`) |
| `cluster` | Parts with >= 8 pins (ICs, connectors, modules) each seed their own block. | neither of the above | the anchor's refdes |

The nets used for voting are signal nets plus nets that are local to one sheet even if their name looks
like a rail (`/Supply/5V_SW`, `/Supply/3V3_FB`): they are a converter's own nodes and tie the converter
to its sheet. Ground and nets with more than 40 pins never count.

### 2. Connectivity

Unplaced parts join the block their neighbours on those nets belong to, for up to six rounds. A neighbour
that is an anchor (>= 8 pins, not a resistor/capacitor array, LED bar or test point) counts three times,
so a series resistor between two blocks goes to the IC side.

### 3. Proximity

Parts that only touch rails (decoupling and bulk caps) join the block of the nearest placed anchor that
shares one of their supply rails, within 15 board units (mm on both test boards).

### 4. Description

Per block: members, anchors (most pins first), supply rails used (ground excluded) and the boundary,
i.e. every signal net shared with another block together with the blocks on the other side.

Results on the test boards:

| Board | Source | Blocks | Placed directly / connectivity / proximity / unplaced |
|---|---|---|---|
| Jetson Orin baseboard (KiCad 9) | `sheet` | 9: USB_Debug,_DP, SoM, Supply, Peripherals, CSI, HDMI, USB3, M.2, Ethernet | 430 / 164 / 53 / 19 |
| Pixhawk FMUv3 (Altium 20.1) | `refdesBand` | 10: `1xxx` (STM32F4 FMU) ... `10xxx` (charger, LDO) | 149 / 12 / 1 / 1 |

## Interfaces

`detectInterfaces(board)` buckets signal nets by name. A net's name (leaf of the hierarchical name, KiCad
overbar `~{...}` and `{slash}` unwrapped) is split into tokens on `_ - . /`.

- The first token that names a bus decides kind and bus name: `CSI0_D0_N` -> MIPI CSI/DSI `CSI0`,
  `GPIOEX_I2C_SCL` -> I2C `GPIOEX_I2C`. Known bus tokens: CSI/DSI, HDMI, DP<n>/eDP<n>, PCIe, USB*,
  Ethernet (ETH, GBE, MDI, RGMII, RMII, SGMII), SDIO/SDMMC/eMMC, JTAG/SWD, I2S/SAI/TDM, CAN, I2C/SMBus/TWI,
  SPI/QSPI, UART/USART.
- Otherwise the first token that names a signal role decides the kind, and the tokens before it are the
  bus name: `SYS_SCL` -> I2C `SYS`. Roles: SDA/SCL, MOSI/MISO/SCK, TXD/RXD/RTS/CTS, PERST/CLKREQ/REFCLK,
  TMDS/CEC/DDC, HPD, CC1/CC2/SBU, MDIO/MDC, TCK/TMS/TDI/TDO/SWDIO/SWCLK, LRCLK/BCLK/MCLK.
- Skipped: rails, nets with fewer than two pins, names the EDA tool made up (`unconnected-(...)`,
  `Net-(...)`, Altium `NetR7012_P$1`) and nets that supply a bus (`CSIA_I2C_VCC`).

Per bus: its nets, differential pairs (`_P`/`_N`, `+`/`-`, `_DP`/`_DN`), endpoints (anchors on a bus net,
or one hop behind a small series part), series parts and parts tying a bus net to a rail (pull-ups, ESD,
termination). `odb_interfaces` also names the blocks the endpoints belong to.

## Tools

| Tool | Arguments | Output |
|---|---|---|
| `odb_overview` | `design` | part/net/rail counts, board extent, data coverage (value, description); blocks with key parts, main rails and boundary size; interfaces per kind; supply rails by pin count |
| `odb_block` | `block` (name or member refdes), `design` | key parts with value, description, pin count and side; other parts by refdes prefix; supply rails; nets to other blocks |
| `odb_interfaces` | `kind` (kind or bus name regex), `refdes` (part on the bus), `design` | buses grouped by kind with nets, diff pairs, ends, series parts, pull-ups |

All three run on the in-memory `BoardIndex` (about 50 ms on the Jetson board) and respect the
property mapping: rails and test points come from `isRail`/`isTestPoint`, values and descriptions from
the mapping. They wait for a running mapping repair of value and description like `odb_search` does.

## Limits

- Block names are sheet names or refdes bands; nothing names what a band does yet. An agent pass
  naming blocks from their members, cached like the mapping overlay, is a possible follow-up.
- No power tree yet. Supply rails are listed per block, but converters are not linked to their input and
  output rails. That needs a better rail classifier first: `RAIL_NAME` also matches converter control
  nets like `/Supply/5V_EN` and `/Supply/3V3_FB`.
- Interface detection depends on net naming; boards with mostly auto-named nets show few buses.
- A part that ties two blocks equally (e.g. a pull-up shared by two ICs) goes to the first vote.
