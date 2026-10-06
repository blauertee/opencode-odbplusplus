# Exporting ODB++ from Altium Designer

This guide covers exporting an Altium Designer board as ODB++ so the plugin can answer as many
questions about it as possible. Menu names are from Altium Designer 20.1. Newer versions use the
same paths unless noted.

The short version: put the part data on the PCB components, export ODB++ with the PCB as the
active document, pack the `odb` folder as a `.tgz`, and check that the archive has component
properties in it.

## What the plugin reads

The plugin only sees what ends up in the ODB++ files. From an Altium export that is:

| Plugin field | Comes from | ODB++ location |
|---|---|---|
| Refdes | PCB designator | `components` (`CMP` record) |
| Part name | PCB component *Comment* | `components` (`CMP` record) |
| Package | PCB footprint name | `eda/data` (`PKG`) |
| Pins and nets | PCB netlist | `eda/data` (`NET`, `SNT`) |
| Value, MPN, datasheet, description | component parameters, **if they are on the PCB component** | `components` (`PRP` records) |

The value, MPN, datasheet and description lookups match parameter names case-insensitively, first
match wins (`src/board.ts`):

| Field | Accepted parameter names |
|---|---|
| Value | `Value`, `Val`, `Comment` |
| MPN | `MPN`, `Manufacturer Part Number`, `Manufacturer_Part_Number`, `Part Number`, `PartNumber`, `PN` |
| Datasheet | `Datasheet`, `Datasheet URL`, `DatasheetURL`, `ComponentLink1URL`, `Help URL` |
| Description | `Description`, `Desc` |

Without these, the plugin still has refdes, part name, footprint and connectivity. That covers
search, `odb_component`, `odb_net` and `odb_signal_path`. You lose MPN search, datasheet chapters
(`odb_datasheet`) and value-based answers.

> **Not verified yet:** our only Altium test export (`testdata/altium.pixhawk-fmuv3.tgz`) came from
> a PCB without parameters, so we have not yet seen Altium write `PRP` records. Step 7 below shows
> how to check your own export. Please report what you find (issue #3).

## 1. Clean up the parameters in the schematic

Parameters are defined on the schematic parts. Make them consistent first.

1. Open the project (`.PrjPcb`) and compile it: **Project → Validate PCB Project**. Fix
   duplicate designators. The plugin keys everything by refdes.
2. Open **Tools → Parameter Manager**. Tick all parts and run it on the whole project.
3. Check that each part has:
   - `Value`, e.g. `10K`, `100nF`, `STM32F427VIT6`.
   - `MPN`: the exact orderable part number. Prefer `MPN` over `Manufacturer Part Number`.
     ODB++ property names are single tokens, so exporters replace spaces (KiCad writes
     `Max._Curr.` for `Max. Curr.`). `MPN` survives that unchanged.
   - `Datasheet`. This must be a **direct `https://` link to a PDF**. `odb_datasheet` downloads it
     and rejects HTML landing pages. Network paths such as `\\server\Datasheets\x.pdf` do not
     work. Altium's own `HelpURL` parameter is **not** matched (only `Help URL` with a space is), so
     copy the link into a `Datasheet` parameter.
   - `Description` (optional, used by search).
4. Rename odd names in the Parameter Manager. For example, rename `MFGPN` to `MPN` and
   `DATASHEET` to `Datasheet`. In a project with several MPN-like fields
   (`Manufacturer Part Number`, `Manufacturer1 Part Number`, `Part Number`, …), copy the one you
   want into `MPN`. That name is checked first.
5. Set each part's **Comment** to the value (`=Value`). The Comment is always exported as the
   ODB++ part name, so it is the fallback when no parameters come through.
6. Click **Accept Changes (Create ECO)** and execute the ECO.

## 2. Give nets and test points readable names

The agent sees net names as they are. Unnamed nets come out as `NetR7012_P$1`, which tells it
nothing.

- Put net labels on every signal that matters (buses, interfaces, enables, sense lines).
  Power ports already name the rails.
- Give test points a `TP` designator prefix (`TP1`, `TP2`, …), or a footprint or comment that
  contains `TP` or `TestPoint`. `odb_testpoints` finds them that way. If your test points are
  called something else (e.g. `FMU-SWCLK`), pass a refdes `pattern` to the tool.

## 3. Push the parameters into the PCB

**This is the step that is easy to miss.** Schematic parameters do not reach the PCB components
automatically. The ODB++ export is written from the PCB, so parameters that only exist on the
schematic are lost.

1. Open **Project → Project Options → Comparator**. Under *Parameters*, set
   *Different Parameters* and *Extra Parameters* to **Find Differences**. Click OK.
2. Open the PCB and run **Design → Update PCB Document *&lt;name&gt;*.PcbDoc**.
3. In the Engineering Change Order dialog, look for the *Add Parameters* / *Change Parameter Value*
   lines. If the layout is final, untick every other change (footprints, nets, rooms, classes).
4. Click **Validate Changes**, then **Execute Changes**, and save the PcbDoc.
5. Check it: in the PCB, select a part (e.g. the MCU) and open the **Properties** panel. Its
   **Parameters** section should list `Value`, `MPN` and `Datasheet`.

## 4. Export ODB++ from the PCB editor

1. Click into the **`.PcbDoc` tab** so the PCB is the active document. The fabrication outputs
   only appear in the **File** menu while a PCB is active. With a schematic or the project
   selected, they are not there.
2. **File → Fabrication Outputs → ODB++ Files**.
3. In the ODB++ setup dialog:
   - Tick **all layers**: copper, solder mask, paste, overlay and mechanical layers, and the drill
     pairs. The component layers (`comp_+_top`, `comp_+_bot`) carry the parts. Without copper and
     drill layers the netlist is still there, but the board data is incomplete.
   - Keep the units as they are. Millimetres and inches both work.
4. Click OK. Altium writes the output to `Project Outputs for <project>/` (shown in the Messages
   panel), in a folder that contains an `odb` directory with `matrix/`, `steps/`, `misc/` and so on.

### Alternative: an Output Job (repeatable)

Use this if the menu entry is missing, or if you export more than once.

1. **File → New → Output Job File** (or open the project's existing `.OutJob`).
2. Under **Fabrication Outputs**, click **Add New Fabrication Output → ODB++ Files** and choose
   the PcbDoc as data source.
3. Right-click the new output → **Configure** and set the layers as in step 4.3.
4. Under **Output Containers**, add or pick a **Folder Structure** container, set its output path,
   tick the ODB++ output's *Enabled* box and click **Generate Content**.
5. Save the OutJob in the project. Later exports are a single **Generate Content** click.

## 5. Pack it as `.tgz`

The plugin reads `*.tgz` and `*.zip` archives from `designs/` (or `ODB_DESIGNS_DIR`). The archive
must have the `odb` folder at its top level, i.e. `odb/matrix/matrix` and not
`Project Outputs/ODB/odb/matrix/matrix`.

Windows 10+ (cmd or PowerShell, `tar` is built in):

```bat
cd "Project Outputs for FMU3_REV_D"
tar -czf my-board.tgz odb
```

Linux / macOS:

```bash
tar -czf my-board.tgz -C "Project Outputs for FMU3_REV_D" odb
```

The archive name, without `.tgz`, becomes the design name in `odb_designs`.

## 6. Check the archive

```bash
tar -tzf my-board.tgz | head                     # first entries must start with odb/
tar -tzf my-board.tgz | grep -c 'components$'    # 2: comp_+_top and comp_+_bot
```

## 7. Check that the parameters made it

```bash
tar -xzOf my-board.tgz --wildcards '*/comp_+_top/components' | grep -m10 '^PRP'
```

Expected output looks like this (taken from the KiCad test board):

```
PRP Datasheet 'https://fscdn.rohm.com/en/products/databook/datasheet/passive/resistor/chip_resistor/pmr-jpw-e.pdf'
PRP Description ''
PRP MPN 'ERJ2GE0R00X'
```

- **No `PRP` lines:** the parameters are not on the PCB components. Redo step 3.
- **`PRP` lines with other names:** rename the parameters (step 1.4) and export again.
- **Only `CMP` lines whose last fields are `220R`, `STM32F4…`:** that is the Comment as part
  name. It is the fallback, and it means there are no parameters.

Then load it in the plugin and ask for a part, e.g. `odb_component { refdes: "U1" }`. The output
should list value, MPN and package.

## Known Altium quirks

- **No `misc/info` file.** Altium 20.1 does not write `odb/misc/info`, and OdbDesign used to fail
  with `misc/info file does not exist`. The plugin patches this (`native/patches/0003-optional-misc-info.patch`).
  If you built the native library before that patch existed, rebuild it from scratch:
  `rm -rf native/vendor/OdbDesign && bun run build:native`.
- **Comment as part name.** The ODB++ part name is the component Comment, not the library
  reference. Set Comment to `=Value` (step 1.5) so it is useful.
- **`$NONE$` net.** Unconnected pins go to the ODB++ pseudo-net `$NONE$`. The plugin skips it in
  path searches.
- **Variants.** Not tested yet. If the project has assembly variants, note which one was active
  when you exported, and name the archive after it.
