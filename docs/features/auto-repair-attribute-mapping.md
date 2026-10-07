# Auto-repair of attribute mappings

ODB++ carries component properties verbatim from the EDA tool, and every tool and part library
names them differently. The plugin reads a fixed set of fields (value, MPN, datasheet, description,
manufacturer) and recognises test points, power rails and mechanical parts. When an export uses
names or conventions the built-in tables do not know, the tools would silently answer with less.

This feature detects that case and repairs it. A cheap, deterministic health check decides whether a
design looks under-mapped. If it does, the plugin runs the `odb-mapper` subagent, which ships with
the plugin, in a child OpenCode session. The agent proposes mapping rules, the plugin checks every
rule against the parsed data, and the accepted rules are stored as an overlay next to, never inside,
the original export and applied in memory every time the design loads.

Code: `src/mapping/`. Tests: `test/mapping.test.ts`.

## What is mapped

| Target | Kind | Used by | Built-in source (`src/aliases.ts`, `src/board.ts`) |
|---|---|---|---|
| `value` | field | summaries, `odb_search` | aliases `Value`, `Val`, `Comment` |
| `mpn` | field | summaries, `odb_search` | `MPN`, `Manufacturer Part Number`, `MFGPN`, …, generic `Part Number`/`PN` last |
| `datasheet` | field | `odb_datasheet` | `Datasheet`, `Datasheet URL`, `ComponentLink1URL`, `HelpURL`, … (an `https://` link wins) |
| `description` | field | `odb_component`, `odb_search` | `Description`, `Desc` |
| `manufacturer` | field | `odb_component` | `Manufacturer`, `Manufacturer 1`, `Mfr`, … |
| `testPoint` | feature, per component | `odb_testpoints` | `TP<n>` refdes, or `TP`/`TestPoint` in package, part or value on a part with at most 2 pins |
| `rail` | feature, per net | path search, summaries | `RAIL_NAME` regex, or fanout > 40 |
| `mechanical` | feature, per component | health check eligibility | parts without a pin on a real net |

A field can come from a property, from the ODB++ part name (Altium writes the component Comment
there), or from a fixed value the agent proposed for one component. `odb_component` shows where a
value did not come from a plain property, e.g. `mpn: BQ24313 (inferred from part name, verified)`.

The parsed data is never modified. `BoardIndex.components[].properties` stays as parsed; the
mapping only changes how it is read (`BoardIndex.mapping`, `resolve()`).

## When the agent starts

### Health check (`health.ts`)

`mappingHealth(board)` runs on every load and takes milliseconds. It looks at **eligible**
components: at least one pin on a real net (not `$NONE$`) and not mechanical. Mounting holes and
fiducials without a net are therefore out; ones with a net stay in until a rule marks them
mechanical.

| Signal | Fires when | Strength |
|---|---|---|
| S1 | A property no alias or ignore rule covers is on ≥ 10 % of eligible parts (min. 5), ≥ 60 % of its sampled values look like a field (shapes below), and that field is mapped on < 90 % of parts | strong |
| S2 | `value` is mapped on < 70 % of eligible parts, or `mpn` on < 50 % of eligible non-passives, and the part name is set (and differs from the footprint) on ≥ 50 % of the uncovered ones | strong |
| S3 | No test points found and ≥ 3 eligible parts with ≤ 2 pins have a refdes prefix outside the known classes, or ≥ 5 such parts even when test points exist | strong |
| S4 | ≥ 3 eligible parts (and ≥ 3 %) have a refdes prefix outside the known classes (`U$`, `IO-`, `FMU-`, a bare `5v`) | weak |
| S5 | ≥ 5 chosen MPNs and ≥ 30 % of them fail the offline MPN checks (values, distributor numbers, library names, family mismatch, see below) | strong |
| S6 | A net with fanout ≥ 20, ≥ 60 % of it on 2-pin capacitors, is not treated as a rail | weak |
| S7 | ≥ 5 and ≥ 20 % of the values of a mapped field are placeholders (`~`, `-`, `NA`, `TBD`, …); empty strings do not count | weak |

Value shapes used by S1 (`shapeHits`): `mpn` has letters and digits and passes the tier-1 MPN
checks; `value` is a passive value (`10k`, `4k7`, `100nF`, `0u1`, `10u/25V`); `datasheet` is a
link or a `.pdf` path; `description` has ≥ 3 words; `manufacturer` matches a built-in list of
manufacturer names or repeats across many parts with ≤ 3 words. Known refdes prefixes and ignored
property names are `KNOWN_REFDES_PREFIXES` and `IGNORED_PROPERTIES` in `src/aliases.ts`.

A run is **warranted** (`launch`) when the design has ≥ 5 eligible components and any strong
signal or at least two weak ones fire.

Results on the test boards (asserted in `test/mapping.test.ts`):

| Design | Signals | Launch |
|---|---|---|
| Jetson (KiCad) | none that start a run | no |
| Pixhawk (Altium, no parameters) | S2 (value and MPN), S3 (9 `PAD.04` pads), S4 | yes |

### Decision and timing (`service.ts`, `store.ts`)

Every design tool (all except `odb_designs` and `odb_mapping`) opens the design through `DesignStore.open()`, which calls
`MappingService.maybeRepair()`. A run starts in the background when the health check says launch
and none of these hold:

- the plugin option `mappingAgent` is `off` (`ODB_MAPPING_AGENT=off`), or no agent is available;
- a stored overlay for this archive exists that was written with the current health check and
  prompt version (`heuristicVersion`, `promptVersion`). An overlay exists after every finished run,
  including one that only reported `unresolved` targets, so a design whose data simply is not there
  (Pixhawk MPNs) does not trigger new runs;
- a run is already in flight, or one already ran in this process (a failed run writes no overlay
  and is retried in the next process; `odb_mapping repair` forces one at any time).

Tools never wait for connectivity queries. `odb_testpoints` (when a `testPoint` gap exists),
`odb_datasheet` (`datasheet` gap) and `odb_search` (queries with letters and digits, `mpn`/`value`
gaps) wait for a running repair, at most `mappingWaitMs` (default 60 s). Every tool appends
`note: the property mapping of this design is being repaired; values may be incomplete.` while a
repair runs. When it finishes, the new rules are applied to the same `BoardIndex`, so later calls
see them.

## The cache (`overlay.ts`)

The ODB++ archive and its extracted working copy are never written. All mapping state lives in
separate JSON files:

```
$ODB_CACHE_DIR/                          default ~/.cache/opencode-odbplusplus
  boards/<key>/…                         working copies of archives (existing)
  mappings/
    designs/<fingerprint>.json           design overlay: accepted rules, unresolved targets, summary,
                                         MPN verification, coverage before and after
    conventions.json                     property conventions learned on other designs
    runs/<fingerprint>/<timestamp>.json  agent input and result of each run, for debugging
<designsDir>/<stem>.mapping.json         optional hand-written overrides, read-only for the plugin
```

`mappingDir` (`ODB_MAPPING_DIR`) moves `designs/` into the project, e.g. to commit agent results.

**Fingerprint:** SHA-256 of the archive bytes, so a renamed or copied archive keeps its overlay and
a re-export with different content gets a fresh one. Overlays carry `schemaVersion`,
`heuristicVersion` and `promptVersion`. A different `schemaVersion` drops the overlay. An older
`heuristicVersion` or `promptVersion` keeps applying it but allows a new run if the health check
still fires; that run gets the newest overlay of an earlier revision with the same archive name as
`previousMapping`.

**Layers**, applied in this order (`mergeMappings`):

1. built-in aliases, conventions and ignore lists;
2. learned conventions: only `ignoreProperty` and unscoped `propertyAlias` rules with confidence
   `high` are promoted from an accepted result, and apply to every design;
3. the design overlay;
4. user overrides in `<stem>.mapping.json` (`{ "rules": [...] }`, same rule format as below),
   validated on load; invalid entries are reported by `odb_mapping`. The agent sees them as fixed,
   and any rule it proposes that targets the same thing is rejected.

Later layers win for `classify`, `partNameAs`, scoped aliases and fixed component values. A plain
`propertyAlias` is added after the existing aliases unless it says `priority` `before` with
`relativeTo`. Field resolution order: fixed `componentValue`, then aliases scoped to the refdes
prefix, then global aliases in order, then the part name (`partNameAs`, `value` and `mpn` only).
Properties named by `ignoreProperty` and placeholder values (`~`, empty, `NA`, …) are skipped.

`odb_mapping` with `action: "reset"` deletes the design overlay (`conventions: true` also clears
learned conventions).

## The agent (`agent.ts`, `service.ts`)

- **Registration.** The plugin's `config` hook adds a hidden subagent `odb-mapper`: temperature 0,
  at most 12 steps, no edit, bash or web access, and only these tools: `odb_component`, `odb_net`,
  `odb_mapping_profile`, `odb_mapping_values`, `odb_mapping_submit`. The three `odb_mapping_*`
  tools are switched off for every other agent and only answer inside a run. The model is
  `mappingModel` (`ODB_MAPPING_MODEL`, `provider/model`), else OpenCode's `small_model`, else the
  session default. A user's own `agent["odb-mapper"]` config overrides ours.
- **Run.** `client.session.create` with the triggering session as parent (the run shows up as a
  child session), then `client.session.prompt` with `agent: "odb-mapper"` and the profile as JSON.
  A run ends on the first submit without rejected rules, after the third submit
  (`MAX_SUBMITS`), when the prompt returns, or at `mappingTimeoutMs` (default 180 s). The session
  is aborted once a result is in or on timeout. Whatever was accepted by then is kept; with no
  submit at all, no overlay is written.
- **Result.** The accepted rules, the agent's `unresolved` list and summary, MPN verification
  and the coverage before and after are written as the design overlay. High-confidence portable
  rules are promoted to conventions. `odb_mapping` shows the last outcome.

### Input: the design profile (`profile.ts`)

`MappingInput` (types in `schema.ts`) is a compact profile, not the board. Lists are capped; it is
about 3 000 tokens for the Pixhawk export and 7 000 for the Jetson board.

- `design`: name, first 16 hex characters of the fingerprint, component, eligible and net counts;
- `targets`: the definitions from the table above (`TARGETS` in `prompt.ts`);
- `currentMapping`: aliases per field, ignored properties, coverage per field with the source
  counts, test point count and sample, rail count and sample;
- `gaps`: what the health check found (signal, target, one-sentence summary, candidate names);
- `properties`: up to 60 property names by frequency, with count, distinct values, current
  mapping, `shapeHits` and up to 6 sample values spread over refdes prefixes;
- `partNames`: how many parts have one, how many equal the footprint, 15 spread samples;
- `refdesClasses`: up to 40 refdes prefixes with count, pin range, known flag and 4 samples;
- `smallPartCandidates`: up to 40 eligible parts with ≤ 2 pins and an unknown prefix or a
  test-point-like name; `railCandidates`: up to 20 nets (S6);
- `previousMapping` and `userOverrides` when present.

The agent can read more through `odb_mapping_profile` (one section again) and
`odb_mapping_values` (all distinct values of a property, the part name or the package, with
counts and up to 3 refdes each, optionally for one prefix, max 200).

### Output: rules (`schema.ts`)

The agent answers by calling `odb_mapping_submit` with `{ rules, unresolved, summary }`. The tool's
argument schema is the output schema, so a malformed call fails before any validation.

| Rule `kind` | Meaning |
|---|---|
| `propertyAlias` | Read `property` as `field`, optionally only for `scope.refdesPrefixes`, and `priority` `before`/`after` `relativeTo` another alias |
| `ignoreProperty` | Never read `property` as a field; `reason` is `internal-number`, `distributor-number`, `unrelated` or `placeholder` |
| `partNameAs` | For parts in `scope` (`refdesPrefixes` and/or `refdes`) use the ODB++ part name as `value` or `mpn` when no property provides it |
| `componentValue` | Fixed `value` for one component's `field`, from a `property`, the `partName`, or `inferred` |
| `classify` | Mark parts as `testPoint` or `mechanical` (`value` true or false) that match `match`: lists `refdes`, `part`, `package` and/or a `refdesPattern` regex; all given criteria must hold, any entry of a list may match |
| `rail` | Mark `nets` as rail or not |

Every rule has `confidence` (`high`, `medium`, `low`) and `evidence` (up to 5 refdes and a note).
`unresolved` lists targets the export cannot fill (`absent-in-export`, `ambiguous`, `needs-user`)
with a detail and an optional suggestion for the EDA export; it stops the check from starting the
agent again for data that is not there.

Example, as validated in the Pixhawk test (abridged):

```json
{ "rules": [
  { "kind": "partNameAs", "field": "value", "scope": { "refdesPrefixes": ["R", "C", "L", "RN", "F", "LED"] }, "confidence": "high", "evidence": { "note": "Altium writes the Comment as part name; on passives it is the value." } },
  { "kind": "partNameAs", "field": "mpn", "scope": { "refdes": ["U10001", "D10001", "U4001", "U4002"] }, "confidence": "medium", "evidence": { "note": "These part names are orderable part numbers." } },
  { "kind": "classify", "feature": "testPoint", "value": true, "match": { "part": ["PAD.04"] }, "confidence": "high", "evidence": { "note": "One-pad parts named after the signal they expose." } },
  { "kind": "classify", "feature": "mechanical", "value": true, "match": { "part": ["MOUNT-HOLE1.8MM"] }, "confidence": "high", "evidence": { "note": "Mounting holes." } }
], "unresolved": [], "summary": "…" }
```

### System prompt (`prompt.ts`)

`MAPPER_SYSTEM_PROMPT`, versioned by `PROMPT_VERSION`. It tells the agent that its only output is the
`odb_mapping_submit` call; defines every target; and instructs it to read the gaps first, prefer
rules over single-part fixes, back each rule with evidence it saw, never invent data (the only
exception is an inferred IC, diode, transistor, crystal or connector MPN from a part name, at most
`medium` confidence), ignore internal and distributor numbers explicitly, classify test points by a
precise match and check at least two candidates with `odb_component`, report what cannot be filled
as `unresolved`, respect user overrides and reuse the previous mapping, and submit once with at
most three tries. It also lists the checks run on a submit, so the agent can avoid them. Change
the prompt meaningfully → bump `PROMPT_VERSION`.

## Validation (`validate.ts`, `mpn.ts`)

Nothing the agent says is applied before `validateOutput` accepts it. Rejected rules are returned
to the agent with their index and reason; the stored overlay contains accepted rules only.

Rule checks:

- `propertyAlias`, `ignoreProperty`: the property exists on the board (normalised name). An alias
  needs values on the parts in scope; a `datasheet` alias needs links on ≥ half of them.
- `partNameAs`: the scope selects parts with a part name that is not just the footprint name.
- `componentValue`: the component exists; a `property` or `partName` source must contain the value;
  `inferred` is only allowed for `value` and `mpn` and not with `high` confidence; a `datasheet`
  must be an `http(s)` link; the value is not a placeholder.
- `classify`: the match is not empty, refdes exist, the regex compiles, at least one part matches.
  Test points: at most 30 % of the eligible parts (min. 3), at most 2 pins, not a part with a common
  component prefix (R, C, L, D, LED, J, U, IC, Q, Y, X, FB, RN, SW), at least one connected.
  Mechanical: at most 4 pins.
- `rail`: all nets exist.
- Rules that touch the same thing as a user override are rejected.

### MPN checks (offline, no credentials)

No offline check can prove an MPN is real; the checks prove that a value is not one, and verify
what they can.

1. **Reject** (`checkMpn`): shorter than 4 or longer than 40 characters, whitespace, a link,
   a passive value (`10k`, `100nF`, `10u/25V`), a Digi-Key (`…-ND`) or LCSC (`C123456`) number, the
   footprint name, no digits, or a library or description name (`Crystal_Oscillator_in_3.2x2.5_SMD`,
   `MMBT3906*SMD`, `ST_STM32F101/103_48pin_LQFP`, `LED0603_Green`). All-digit numbers and a leading
   `NNN-` are not rejected because real MPNs look like that (Molex `5031820852`, TE `2-1734839-1`).
2. **Family grammars:** Murata, Samsung and KEMET MLCCs, Yageo RC and CC, Panasonic ERJ, Vishay CRCW
   (case size decoded and compared with the footprint, e.g. `GRM155…` is 0402), STM32 (pin count
   letter against the footprint's pin count), STM8, Nexperia PMEG, and non-strict patterns for 74
   logic and TI analog. A value that claims a strict family but breaks its numbering, or whose case
   size or pin count contradicts the footprint, is rejected; a full match is **verified**.
3. **Datasheet text** (`mpnLookup: "datasheet"`, `ODB_MPN_LOOKUP`): for still-unverified MPNs
   (max. 20 per validation) the datasheet is fetched through the existing `src/datasheet.ts`
   cache and the MPN, or its base without a packaging suffix, must appear in the text.
4. **Consistency:** the same MPN on parts with different footprints counts as a failure.

An MPN that matches no grammar and has no datasheet evidence is kept as **unverified** and shown
as such. A rule is rejected when more than 30 % of its MPN values fail, or when its only value
fails. With a smaller failing share the rule is accepted, the failing parts are skipped (a
`partNameAs` is narrowed to the parts that passed) and a warning is reported to the agent.
Verification is stored per refdes and value, so a user override with another MPN is not shown as
verified.

## Tools and options

`odb_mapping { design?, action?: "status" | "repair" | "reset", conventions? }` shows coverage per
field, the gaps, the agent's rules and unresolved targets, user overrides (and their errors) and
the outcome of the last run. `status` and `reset` never start the agent; `repair` runs it now and
waits for it.

| Option | Env | Default | |
|---|---|---|---|
| `mappingAgent` | `ODB_MAPPING_AGENT` | `auto` | `off`: never start the agent on its own |
| `mappingModel` | `ODB_MAPPING_MODEL` | `small_model` | `provider/model` for the agent |
| `mappingDir` | `ODB_MAPPING_DIR` | in the cache | where design overlays are stored |
| `mappingWaitMs` | | 60000 | how long gapped tools wait for a running repair |
| `mappingTimeoutMs` | | 180000 | max agent run time |
| `mpnLookup` | `ODB_MPN_LOOKUP` | `off` | `datasheet`: verify MPNs against the datasheet text |

## Tests (`test/mapping.test.ts`)

MPN checks and grammars; health signals on synthetic boards and both test boards; rules changing
how properties are read without changing them; validator rejections (unknown property, refdes,
datasheet links, inferred with `high` confidence, over-broad test point rules); user overrides
winning; a full service run with a stand-in agent (one run, overlay stored outside the archive,
reused by a new store without a second run, archive bytes unchanged); the `config` hook; the agent
runner with a rejected and a corrected submit. The Pixhawk test feeds a fixed proposal through the
validator and checks the 9 test points, the passive values and the inferred, verified MPNs. The
Jetson and Pixhawk tests need the native library (`bun run build:native`).

## Limits

- No run against a real model has been tested. The agent runner is tested against a stand-in
  OpenCode client, so prompt quality, tool use and the child session behaviour in OpenCode are
  unverified. The default `small_model` may be weak at telling MPNs from internal numbers.
- The thresholds were set against two boards (KiCad Jetson, Altium Pixhawk). Pulsonix exports are
  untested (issue #4).
- The family grammars cover a few vendors only; everything else stays unverified. There is no
  offline parts catalogue.
- The ODB++ `.test_point` pad attribute is still not read.
- Learned conventions are the most likely way for a wrong rule to spread; only `high` confidence
  property rules are promoted and `odb_mapping reset` with `conventions: true` clears them.
