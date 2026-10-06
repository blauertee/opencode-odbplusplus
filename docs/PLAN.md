# Plan: ODB++-Inspektion als OpenCode-Toolcalls

Ziel: OpenCode (bzw. jedes LLM mit Toolcalls) soll Leiterplatten-Designs effizient
abfragen können, ohne riesige Netzlisten in den Kontext zu kippen. Typische Fragen:

| Frage | Tool |
|---|---|
| Gib mir alle Verbindungen, die IC35 hat. | `odb_component { refdes: "IC35" }` |
| Gib mir alle Bauteile auf der Signalkette zwischen IC10 und IC35. | `odb_signal_path { from: "IC10", to: "IC35" }` |
| Gib mir alles, was am 5V-Netz hängt. | `odb_net { net: "+5V" }` |
| Gib mir das Description-Kapitel aus dem Datenblatt von IC10. | `odb_datasheet { refdes: "IC10", section: "Description" }` |
| Wo kommt der TUSB1046 vor? Welche Netze heißen `*I2C*`? | `odb_search { query: "TUSB1046" }` |

Darauf aufbauend: Testabdeckung, Dokumentation und Firmware-Konzeption LLM-gestützt bearbeiten.

## Architektur

```
OpenCode ──toolcall──▶ Plugin (TypeScript, läuft in OpenCode/Bun)
                         │  BoardIndex: Graph Bauteil ⇄ Pin ⇄ Netz, im Speicher je Design
                         │  REST (HTTP, JSON)
                         ▼
                       OdbDesignServer (C++, nam20485/OdbDesign, eigener Prozess / Docker)
                         │  parst
                         ▼
                       ODB++-Archiv (.tgz) aus KiCad / Altium / Pulsonix
```

Warum so geschnitten:

- **OdbDesign bleibt ein eigener Prozess.** Die Bibliothek ist C++ mit vcpkg/gRPC-Build und AGPL-3.0.
  Über REST angebunden brauchen wir keine nativen Bindings, und die Lizenzgrenze bleibt sauber
  (dieses Repo ist GPL-3.0).
- **Die Graph-Abfragen laufen im Plugin.** Der Server liefert Rohdaten (Netze mit Pin-Verbindungen,
  Bauteil-Layer mit Properties). Fragen wie „was liegt zwischen A und B" sind Graph-Suchen, die wir
  einmal pro Design indizieren und dann aus dem Speicher beantworten.
- **Kompakte Textausgabe.** Tools liefern zeilenorientierten Text statt JSON. Rails (GND, +3V3, …)
  werden zusammengefasst, damit ein 500-Pin-GND-Netz nicht den Kontext füllt.

Code:

| Datei | Inhalt |
|---|---|
| `src/client.ts` | REST-Client für OdbDesignServer |
| `src/store.ts` | lädt Designs, cached einen `BoardIndex` pro Design |
| `src/board.ts` | Index, Netzauflösung, Rail-Erkennung, Pfadsuche, Suche |
| `src/format.ts` | Textausgabe der Tools |
| `src/datasheet.ts` | Datenblatt-Download, `pdftotext`, Kapitel-Extraktion |
| `src/tools.ts` | Tool-Definitionen für OpenCode |
| `server/` | Dockerfile + Patches für OdbDesignServer |
| `testdata/` | Testboard als ODB++ |

## Testdesign

[Antmicro Jetson Orin Baseboard](https://github.com/antmicro/jetson-orin-baseboard) (Apache-2.0),
mit KiCad 9 nach ODB++ exportiert (`scripts/export-test-design.sh`):
674 Bauteile, 800 Netze, 8 Kupferlagen, USB-C/DP, Ethernet, M.2, CSI, Power.
Liegt als `testdata/jetson-orin-baseboard.tgz` (2,2 MB) im Repo.

Hinweis: Die Referenzbezeichner sind dort `U…`, nicht `IC…`. Die Beispiele oben funktionieren
mit `U10`/`U35` usw.

## Erkenntnisse aus dem Setup

1. **ODB++ ist Layout, nicht Schaltplan.** Netzliste, Bauteile, Footprints, Positionen und Properties
   sind da. Es fehlen: Pin-*Namen*/Funktionen (nur Padnummern 1…n), Schaltplanseiten und Symbole.
   KiCad kodiert die Seite immerhin im Netznamen (`/USB_Debug,_DP/USBC0_RX1_N`), und unbeschaltete
   Pins tragen den Pinnamen (`unconnected-(U35-FLG-Pad3)`).
2. **Properties sind Gold wert.** KiCad schreibt alle Felder als `PRP`-Records: `Value`, `MPN`,
   `Manufacturer`, `Datasheet` (URL). Damit sind BOM- und Datenblatt-Tools möglich. Altium/Pulsonix
   benennen die Felder anders; `src/board.ts` hat dafür eine Alias-Liste, die wir mit echten
   Exporten nachschärfen müssen.
3. **OdbDesign braucht Patches für KiCad-Exporte.** Gefundene Probleme:
   - Feature-Records ohne Attribut-Teil (`L … P 0` ohne `;…`) → Parse-Error. *Gepatcht.*
   - Leere Attribut-Strings (`&1 `) → Parse-Error. *Gepatcht.*
   - Property-Werte mit Leerzeichen werden abgeschnitten (`'ROHM Semiconductor'` → `ROHM`). *Offen.*
   - Absolute Pfade in CLI-Argumenten werden als Flags interpretiert (`/foo` wie `-foo`), deshalb
     `--designs-dir designs` relativ. *Workaround.*
   - `+` in Layernamen (`comp_+_top`) muss als `%2B` kodiert werden. *Im Client gelöst.*

   Die beiden Parser-Fixes (`server/patches/0001-…`) sollten upstream als PR an OdbDesign gehen.
4. **Server-Build.** Das offizielle Image liegt nur auf ghcr.io, der Upstream-Build zieht alle
   Abhängigkeiten über vcpkg. `server/Dockerfile` baut stattdessen gegen Ubuntus protobuf/gRPC
   (Patch `0002-…`). Lädt das Testboard in ca. 2 s; `GET /designs/{name}` liefert 16 MB JSON, weil
   jede Pin-Verbindung das komplette Bauteil inkl. Package einbettet. Für jetzt okay, da einmal pro
   Design gecached.

## Tool-Katalog

✅ in diesem Stand umgesetzt und gegen das Testboard getestet,
🧪 umgesetzt, aber noch nicht end-to-end getestet, ⏳ geplant.

| Tool | Status | Zweck |
|---|---|---|
| `odb_designs` | ✅ | Designs auf dem Server auflisten |
| `odb_component` | ✅ | Bauteil: Wert, MPN, Package, Datenblatt, alle Pins → Netz → Nachbar-Pins |
| `odb_net` | ✅ | Alles an einem Netz, gruppiert nach Bauteil |
| `odb_signal_path` | ✅ | Kürzeste Bauteilketten zwischen zwei Bauteilen, ohne Rails, nur über kleine Bauteile (≤ 4 Pins, einstellbar) |
| `odb_search` | ✅ | Substring/Regex über Refdes, Wert, MPN, Beschreibung, Netznamen |
| `odb_datasheet` | 🧪 | Datenblatt-PDF laden, Kapitel ausschneiden (Downloads waren in der Testumgebung gesperrt) |
| `odb_bom` | ⏳ | Gruppierte Stückliste (Wert/MPN/Anzahl/Refdes) |
| `odb_power_tree` | ⏳ | Rails → Regler → Verbraucher, Eingang → Ausgang |
| `odb_bus` | ⏳ | Busse aus Netznamen erkennen (I2C/SPI/UART/USB/PCIe, Diff-Paare) und Teilnehmer listen |
| `odb_test_coverage` | ⏳ | Pro Netz: Testpunkte/zugängliche Pads, Netze ohne Testzugang |
| `odb_neighbourhood` | ⏳ | Alles innerhalb n Hops um ein Bauteil, optional als Mermaid/DOT für Doku |
| `odb_placement` | ⏳ | Position, Seite, Bauteile in der Nähe (Layout-Review) |

## Phasen

**Phase 0 – Setup (dieser Stand).** Repo-Gerüst, OdbDesignServer-Build, Testdesign, sechs Tools,
Unit- und Integrationstests.

**Phase 1 – Robustheit.**
- Pin-Namen ergänzen: optional KiCad-Schaltplan-Netzliste (`kicad-cli sch export netlist`) bzw.
  Altium-Netzliste einlesen und Padnummer → Pinname/-funktion mappen. Ohne das bleibt
  „Pin 12 von U5" für Firmware-Fragen zu dünn.
- Rail-Erkennung konfigurierbar machen (Regex + Fanout), Widerstandsarrays in der Pfadsuche
  paarweise statt „alles verbunden" behandeln.
- Property-Aliase für Altium und Pulsonix an echten Exporten prüfen.
- Upstream-PRs für die OdbDesign-Parser-Fixes, Property-Truncation fixen.

**Phase 2 – Use-Case-Tools.** Power-Tree, Bus-Erkennung, Testabdeckung, BOM. Danach Firmware-
Konzeption: MCU-Pin → Netz → Peripherie als Tabelle, daraus Pin-Config-Header generieren.

**Phase 3 – Datenblätter.** Robuster Download (Redirects, Landing-Pages, Distributor-Links),
Kapitel-Split über das Inhaltsverzeichnis, Seiten-Suche statt nur Überschriften, Cache pro MPN.

**Phase 4 – Verteilung.** npm-Paket, CI (Unit-Tests + Integrationstest gegen den Server im
Docker), OpenCode-Agent/Skill-Prompt „PCB-Review", Doku.

## Offene Punkte

- Ein echter Export aus Pulsonix und Altium (auch ein kleines Board) zum Prüfen der Property-Namen
  und der OdbDesign-Kompatibilität.
- Server lokal pro Entwickler (Docker) oder zentral? Der Plugin-Client kann beides (URL + Basic Auth).
