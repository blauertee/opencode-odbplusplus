// Component property names per field, as EDA tools and part libraries spell them.
//
// ODB++ carries component properties verbatim from the design, so the same
// field arrives under many names. Lookups compare normalized names (see
// normalizePropertyName): "Manufacturer Part Number", "manufacturer_part_number"
// and "MANUFACTURER-PART-NUMBER" are one alias. Within a field the first
// alias that has a value wins, so list specific names before generic ones.
//
// To support a new naming convention, add its name here; nothing else needs
// to change. docs/altium-export.md lists these names for users.

export const PROPERTY_ALIASES = {
  value: [
    "Value",
    "Val", // KiCad test board
    "Comment", // Altium, when exported as a parameter
  ],
  mpn: [
    "MPN", // KiCad test board
    "Manufacturer Part Number", // Altium (UW Robotics, CERN library)
    "Manufacturer Part Number 1", // Altium supplier links (UW Robotics)
    "Manufacturer1 Part Number", // CERN Altium library
    "Part Number (MPN)", // Altium (UW Robotics)
    "Mfr Part Number",
    "Mfg Part Number",
    "Manufacturer PN",
    "MFGPN", // Pixhawk / 3D Robotics library
    "MFR PN",
    "Part Number", // generic, may be an internal number
    "PN",
  ],
  datasheet: [
    "Datasheet", // KiCad test board, Pixhawk
    "Datasheet URL",
    "Datasheet Link",
    "ComponentLink1URL", // Altium component link
    "HelpURL", // Altium (CERN library, often a network path)
  ],
  description: [
    "Description",
    "Desc",
  ],
} as const satisfies Record<string, readonly string[]>

export type PropertyField = keyof typeof PROPERTY_ALIASES

/** Lowercase and drop everything but letters and digits: spaces, "_", "-", ".", "(", ")". */
export function normalizePropertyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}
