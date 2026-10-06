# Plan: ODB++ inspection as OpenCode tool calls

Goal: OpenCode (or any LLM with tool calls) should be able to query PCB designs efficiently,
without dumping huge netlists into the context. Typical questions:

| Question | Tool |
|---|---|
| Give me every connection IC35 has. | `odb_component { refdes: "IC35" }` |
| Give me all components on the signal chain between IC10 and IC35. | `odb_signal_path { from: "IC10", to: "IC35" }` |
| Give me everything attached to the 5V net. | `odb_net { net: "+5V" }` |
| Give me the Description chapter from the IC10 datasheet. | `odb_datasheet { refdes: "IC10", section: "Description" }` |
| Where is the TUSB1046 used? Which nets are named `*I2C*`? | `odb_search { query: "TUSB1046" }` |

Building on that: LLM-assisted work on test coverage, documentation and firmware design.

## Architecture

```
OpenCode ──tool call──▶ Plugin (TypeScript, runs inside OpenCode/Bun)
                          │  BoardIndex: graph component ⇄ pin ⇄ net, in memory per design
                          │  bun:ffi, same process
                          ▼
                        native/libodbpp  (small C interface, native/odbpp.cpp)
                          │  links
                          ▼
                        libOdbDesign (C++, nam20485/OdbDesign, library only)
                          │  parses
                          ▼
                        ODB++ archive (.tgz/.zip) from KiCad / Altium / Pulsonix
```

- **OdbDesign used directly as a library, no server.** `native/odbpp.cpp` is a C ABI with three
  functions (`odbpp_load_board`, `odbpp_last_error`, `odbpp_free`). It parses the archive with
  OdbDesign, builds the product model and returns exactly the data the index needs: components
  with properties and position, nets with pins. For the test board that is 320 KB instead of the
  16 MB the REST API returns, loaded in about 1 s.
- **Graph queries run in the plugin.** Questions like "what sits between A and B" are graph
  searches that we index once per design and then answer from memory.
- **Compact text output.** Tools return line-oriented text instead of JSON. Rails (GND, +3V3, …)
  are summarised so a 500-pin GND net does not fill the context.
- **Designs are files** in a folder (`designs/` in the project, configurable). OdbDesign extracts
  archives next to themselves, so the plugin works on a copy in the cache.
- **License.** OdbDesign is AGPL-3.0 and is now linked into the process. This repo is GPL-3.0;
  GPL-3.0 §13 allows the combination, and the OdbDesign part of the combined work stays under the
  AGPL. Not an issue for an internal tool; keep it in mind for redistribution or hosting.

Code:

| File | Contents |
|---|---|
| `native/odbpp.cpp` | C ABI over OdbDesign |
| `native/build.sh`, `native/CMakeLists.txt` | fetches OdbDesign + Crow, applies patches, builds `native/lib/` |
| `native/patches/` | parser fixes and library-only build for OdbDesign |
| `src/native.ts` | `bun:ffi` binding |
| `src/store.ts` | finds archives, caches one `BoardIndex` per archive version |
| `src/board.ts` | index, net resolution, rail detection, path search, search |
| `src/format.ts` | tool text output |
| `src/datasheet.ts` | datasheet download, `pdftotext`, chapter extraction |
| `src/tools.ts` | tool definitions for OpenCode |
| `testdata/` | test board as ODB++ |

## Test design

[Antmicro Jetson Orin Baseboard](https://github.com/antmicro/jetson-orin-baseboard) (Apache-2.0),
exported to ODB++ with KiCad 9 (`scripts/export-test-design.sh`):
674 components, 800 nets, 8 copper layers, USB-C/DP, Ethernet, M.2, CSI, power.
Stored in the repo as `testdata/jetson-orin-baseboard.tgz` (2.2 MB).

Note: reference designators there are `U…`, not `IC…`. The examples above work with
`U10`/`U35` etc.

## Findings from the setup

1. **ODB++ is layout, not schematic.** Netlist, components, footprints, positions and properties
   are present. Missing: pin *names*/functions (only pad numbers 1…n), schematic sheets and
   symbols. KiCad at least encodes the sheet in the net name (`/USB_Debug,_DP/USBC0_RX1_N`), and
   unconnected pins carry the pin name (`unconnected-(U35-FLG-Pad3)`).
2. **Properties are gold.** KiCad writes every field as a `PRP` record: `Value`, `MPN`,
   `Manufacturer`, `Datasheet` (URL). That makes BOM and datasheet tools possible. Altium and
   Pulsonix name the fields differently; `src/board.ts` has an alias list for that, which we need
   to refine against real exports.
3. **OdbDesign needs patches for KiCad exports** (`native/patches/0001-…`, should go upstream as
   a PR to OdbDesign):
   - Feature records without an attribute part (`L … P 0` without `;…`) → parse error. *Patched.*
   - Empty attribute strings (`&1 `) → parse error. *Patched.*
   - Property values containing spaces were truncated (`'ROHM Semiconductor'` → `ROHM`). *Patched.*
4. **Build.** Upstream builds all dependencies through vcpkg, including gRPC for the server. The
   library alone only needs protobuf, libarchive, zlib and header-only Crow; `native/patches/0002-…`
   adds an `ODBDESIGN_LIB_ONLY` option and makes the build work with distro packages
   (protobuf 3.21). `native/build.sh` takes about 1.5 min.
5. **Parsing blocks.** `odbpp_load_board` runs synchronously in the OpenCode process (about 1 s for
   the test board, cached afterwards). Move it into a Bun worker later for very large boards.

## Tool catalogue

✅ implemented and tested against the test board,
🧪 implemented but not yet tested end to end, ⏳ planned.

| Tool | Status | Purpose |
|---|---|---|
| `odb_designs` | ✅ | List ODB++ archives in the designs folder |
| `odb_component` | ✅ | Component: value, MPN, package, datasheet, every pin → net → neighbour pins |
| `odb_net` | ✅ | Everything on a net, grouped by component |
| `odb_signal_path` | ✅ | Shortest component chains between two components, skipping rails, only through small parts (≤ 4 pins, configurable) |
| `odb_search` | ✅ | Substring/regex over refdes, value, MPN, description, net names |
| `odb_datasheet` | 🧪 | Fetch the datasheet PDF and cut out a chapter (downloads were blocked in the test environment) |
| `odb_bom` | ⏳ | Grouped bill of materials (value/MPN/count/refdes) |
| `odb_power_tree` | ⏳ | Rails → regulators → loads, input → output |
| `odb_bus` | ⏳ | Detect buses from net names (I2C/SPI/UART/USB/PCIe, diff pairs) and list members |
| `odb_test_coverage` | ⏳ | Per net: test points/accessible pads, nets without test access |
| `odb_neighbourhood` | ⏳ | Everything within n hops of a component, optionally as Mermaid/DOT for docs |
| `odb_placement` | ⏳ | Position, side, nearby components (layout review) |

## Phases

**Phase 0 – Setup (current state).** Repo scaffold, native OdbDesign binding, test design,
six tools, unit and integration tests.

**Phase 1 – Robustness.**
- Add pin names: optionally read the KiCad schematic netlist (`kicad-cli sch export netlist`) or
  an Altium netlist and map pad number → pin name/function. Without that, "pin 12 of U5" is too
  thin for firmware questions.
- Make rail detection configurable (regex + fanout); treat resistor arrays pairwise in the path
  search instead of "everything connected".
- Check property aliases for Altium and Pulsonix against real exports.
- Upstream PRs for the OdbDesign parser fixes.
- Move loading into a Bun worker, test the macOS build (`.dylib`).

**Phase 2 – Use-case tools.** Power tree, bus detection, test coverage, BOM. Then firmware design:
MCU pin → net → peripheral as a table, and generate a pin config header from it.

**Phase 3 – Datasheets.** Robust download (redirects, landing pages, distributor links),
chapter split via the table of contents, page search instead of headings only, cache per MPN.

**Phase 4 – Distribution.** npm package with prebuilt `libodbpp` binaries per platform, CI
(unit tests + integration test against the test board), OpenCode agent/skill prompt "PCB review",
docs.

## Open points

- A real export from Pulsonix and Altium (even a small board) to check property names and
  OdbDesign compatibility.
