// src/lib/columnProps.ts — ground-truth catalog of AppSheet column type-specific
// properties, harvested from the live column editor DOM (every Type option).
// Used to (a) seed the Build prompt so the AI picks REAL labels/values instead
// of guessing, and (b) warn in the validator when a property doesn't fit the
// column's type. Labels handled by dedicated Change fields (Base type, Source
// table / Referenced table name, Values, Columns) are intentionally excluded —
// those go through baseType / referencedTable, not the `properties` map.

export interface TypeProp {
  label: string;
  kind: "dropdown" | "enum" | "checkbox" | "expr" | "other";
  values?: string[]; // only for small enums (used for prompt + value validation)
}

const NUMERIC: TypeProp[] = [
  { label: "Maximum value", kind: "other" },
  { label: "Minimum value", kind: "other" },
  { label: "Increase/decrease step", kind: "other" },
  { label: "Numeric digits", kind: "other" },
  { label: "Show thousands separator", kind: "checkbox" },
  { label: "Display mode", kind: "enum", values: ["Auto", "Standard", "Range", "Label"] },
];
const DECIMAL_DIGITS: TypeProp = { label: "Decimal digits", kind: "other" };
const ENUMISH: TypeProp[] = [
  { label: "Allow other values", kind: "checkbox" },
  { label: "Auto-complete other values", kind: "checkbox" },
  { label: "Input mode", kind: "enum", values: ["Auto", "Buttons", "Stack", "Dropdown"] },
];
const TEXTISH: TypeProp[] = [
  { label: "Maximum length", kind: "other" },
  { label: "Minimum length", kind: "other" },
];
const FORMATTING: TypeProp = { label: "Formatting", kind: "enum", values: ["Plain Text", "Markdown", "HTML"] };
const FOLDER: TypeProp = { label: "Image/File folder path", kind: "expr" };
const KML: TypeProp = { label: "Optional Url for KML File", kind: "other" };

export const COLUMN_TYPE_PROPS: Record<string, TypeProp[]> = {
  Address: [KML, { label: "Geocoding enabled?", kind: "checkbox" }],
  ChangeCounter: [{ label: "Update Mode", kind: "enum", values: ["Accumulate", "Reset"] }],
  Color: [...ENUMISH],
  Date: [{ label: "Use long date format", kind: "checkbox" }],
  DateTime: [
    { label: "Ignore seconds", kind: "checkbox" },
    { label: "Minimum date", kind: "other" },
    { label: "Maximum date", kind: "other" },
    { label: "Use long date format", kind: "checkbox" },
  ],
  Decimal: [...NUMERIC, DECIMAL_DIGITS],
  Drawing: [FOLDER],
  Duration: [{ label: "Ignore seconds", kind: "checkbox" }],
  Enum: [...ENUMISH],
  EnumList: [...ENUMISH, { label: "Item separator", kind: "other" }],
  File: [FOLDER],
  Image: [FOLDER, { label: "Allow drawing on images", kind: "checkbox" }],
  LatLong: [KML],
  LongText: [...TEXTISH, FORMATTING],
  Name: [...TEXTISH, FORMATTING],
  Number: [...NUMERIC],
  Percent: [...NUMERIC, DECIMAL_DIGITS],
  Phone: [{ label: "Callable", kind: "checkbox" }, { label: "Textable", kind: "checkbox" }],
  Price: [...NUMERIC, DECIMAL_DIGITS, { label: "Currency symbol", kind: "dropdown" }],
  Progress: [...ENUMISH],
  Ref: [
    { label: "Is a part of?", kind: "checkbox" },
    { label: "External relationship name", kind: "other" },
    { label: "Input mode", kind: "enum", values: ["Auto", "Buttons", "Dropdown"] },
  ],
  Show: [
    { label: "Category", kind: "enum", values: ["Page_Header", "Section_Header", "Text", "Url", "Image", "Video"] },
    { label: "Content", kind: "expr" },
  ],
  Signature: [FOLDER, { label: "Save externally", kind: "checkbox" }],
  Text: [...TEXTISH],
  Thumbnail: [FOLDER],
  Time: [{ label: "Ignore seconds", kind: "checkbox" }],
  Url: [{ label: "Launch externally", kind: "checkbox" }, { label: "Is hyperlink", kind: "checkbox" }],
  Video: [{ label: "Launch externally", kind: "checkbox" }],
  XY: [KML, { label: "Background image for the XY coordinates", kind: "expr" }],
  "Yes/No": [{ label: "Yes/No display values", kind: "expr" }],
};

/** Action-type-specific properties (labels NOT owned by a dedicated Change
 *  field). Target / Referenced* / Table-to-add-to / Set-these-columns / Actions
 *  are excluded (they map to target / referenced* / targetTable / assignments /
 *  actions). Harvested from the live "Do this" iteration. */
export const ACTION_TYPE_PROPS: Record<string, TypeProp[]> = {
  EDIT_RECORD: [{ label: "Desktop behavior", kind: "enum" }],
  EXPORT_VIEW: [{ label: "CSV file locale", kind: "dropdown" }],
  IMPORT_FILE: [{ label: "CSV file locale", kind: "dropdown" }],
  NAVIGATE_URL: [{ label: "Launch External", kind: "checkbox" }],
  OPEN_FILE: [{ label: "File", kind: "expr" }],
  CALL: [{ label: "To", kind: "expr" }],
  SMS: [{ label: "To", kind: "expr" }, { label: "Message", kind: "expr" }],
  EMAIL: [{ label: "To", kind: "expr" }, { label: "Subject", kind: "expr" }, { label: "Body", kind: "expr" }],
};

/** Compact per-key property listing for the Build prompt. */
function renderCatalog(catalog: Record<string, TypeProp[]>): string {
  return Object.entries(catalog)
    .filter(([, props]) => props.length)
    .map(([key, props]) => {
      const parts = props.map((p) => {
        if (p.kind === "checkbox") return `"${p.label}"(true/false)`;
        if (p.kind === "enum" && p.values) return `"${p.label}"(${p.values.join("|")})`;
        return `"${p.label}"`;
      });
      return `- ${key}: ${parts.join(", ")}`;
    })
    .join("\n");
}

/** Validate a `properties` map against a catalog entry. Warnings only (never blocks). */
function validateProps(catalog: Record<string, TypeProp[]>, key: string | undefined, properties: Record<string, string>): string[] {
  if (!key) return [];
  const allowed = catalog[key];
  if (!allowed) return []; // unknown key — can't ground, stay silent
  const byLabel = new Map(allowed.map((p) => [p.label.toLowerCase(), p]));
  const warns: string[] = [];
  for (const [label, value] of Object.entries(properties)) {
    const p = byLabel.get(label.toLowerCase());
    if (!p) {
      warns.push(`properties: "${label}" không phải property của ${key}`);
      continue;
    }
    if (p.kind === "checkbox" && value !== "true" && value !== "false") {
      warns.push(`properties: "${label}" cần "true"/"false", nhận "${value}"`);
    } else if (p.kind === "enum" && p.values && !p.values.includes(value)) {
      warns.push(`properties: "${label}" phải là một trong ${p.values.join("|")}, nhận "${value}"`);
    }
  }
  return warns;
}

export const renderColumnTypeProps = () => renderCatalog(COLUMN_TYPE_PROPS);
export const renderActionTypeProps = () => renderCatalog(ACTION_TYPE_PROPS);
export const validateColumnProperties = (type: string | undefined, properties: Record<string, string>) =>
  validateProps(COLUMN_TYPE_PROPS, type, properties);
export const validateActionProperties = (actionType: string | undefined, properties: Record<string, string>) =>
  validateProps(ACTION_TYPE_PROPS, actionType, properties);
