import * as XLSX from "xlsx";

/** One row extracted from an Appendix table sheet, before matching
 * against reference.soc_occupation_master. `socCode` is null when the
 * row's code cell couldn't be parsed as a 4-digit code AND there was
 * no open record to attach it to as a continuation - these become
 * "Invalid" in the import preview rather than being guessed at. */
export interface ParsedAppendixRow {
  socCode: string | null;
  relatedJobTitles: string;
  goingRate: number | null;
  goingRate90: number | null;
  goingRate80: number | null;
  goingRate70: number | null;
  phdPointsEligible: boolean | null;
  /** Raw, non-numeric rate text preserved verbatim when a column says
   * something like "See current GOV.UK Table 3" instead of a figure -
   * never silently dropped, never turned into a number. */
  rateNote: string | null;
  raw: Record<string, unknown>;
}

const SOC_CODE_PATTERN = /^(\d{4})\s+(.*)/;

/** £88,100 (£45.18 per hour) -> 88100. Returns null (not 0) for
 * "Not applicable", "See current GOV.UK Table 3", blank cells, or
 * anything else that isn't a parseable currency figure - the caller
 * is responsible for deciding whether to keep the original text as a
 * note rather than inventing a number. */
function parseRate(cell: unknown): { value: number | null; note: string | null } {
  if (cell == null) return { value: null, note: null };
  const text = String(cell).trim();
  if (!text) return { value: null, note: null };
  const match = text.match(/£\s?([\d,]+)/);
  if (match) return { value: Number(match[1].replace(/,/g, "")), note: null };
  // Not a currency figure at all (e.g. "Not applicable", or a pointer
  // like "See relevant pay band in Table 4") - preserve the text,
  // don't fabricate a number.
  return { value: null, note: text };
}

function parsePhd(cell: unknown): boolean | null {
  if (cell == null) return null;
  const text = String(cell).trim().toLowerCase();
  if (text === "yes") return true;
  if (text === "no") return false;
  return null; // "Not applicable" or blank - genuinely unknown, not false
}

/** Column layouts differ by table (confirmed by inspecting every
 * sheet directly rather than assuming one shape). Each entry says
 * which column index holds what, after XLSX.utils.sheet_to_json
 * produces an object keyed by the sheet's own header row - so this
 * works off header text, not position, to tolerate minor header
 * variation between tables. */
function pickRate(row: Record<string, unknown>, ...headerCandidates: string[]) {
  for (const h of headerCandidates) {
    if (h in row) return parseRate(row[h]);
  }
  return { value: null, note: null };
}

function pickText(row: Record<string, unknown>, ...headerCandidates: string[]): string {
  for (const h of headerCandidates) {
    if (h in row && row[h] != null) return String(row[h]).trim();
  }
  return "";
}

/** Parses one Appendix table sheet into ParsedAppendixRow[]. Handles:
 * - SOC code + title concatenated in the first cell ("1111 Chief executives...")
 * - continuation rows (blank/unparseable code cell) - appended to
 *   whichever record is currently open, from either the job-titles
 *   column or (rarer, but confirmed present) the code column itself
 * - genuinely orphaned fragments (no open record to attach to) -
 *   returned with socCode: null so the caller can bucket them Invalid
 */
export function parseAppendixTable(sheet: XLSX.WorkSheet): ParsedAppendixRow[] {
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  const codeHeader = Object.keys(rows[0] ?? {}).find((h) => /soc.*2020.*occupation.*code/i.test(h));
  if (!codeHeader) return [];

  const results: ParsedAppendixRow[] = [];
  let current: ParsedAppendixRow | null = null;

  for (const row of rows) {
    const codeCell = row[codeHeader];
    const codeText = codeCell == null ? "" : String(codeCell).trim();
    const match = codeText.match(SOC_CODE_PATTERN);

    if (match) {
      // Starts a new record.
      const rate = pickRate(row, "Going rate (SW – options A and D)", "Going rate (SW – options F and I, GBM and SCU)", "Going rate (SW – option F)", "Going rate (annual)");
      const rate90 = pickRate(row, "90% of going rate (SW – option B)", "90% of going rate (SW – option G)");
      const rate80 = pickRate(row, "80% of going rate (SW – option C)", "80% of going rate (SW – option H)");
      const rate70 = pickRate(row, "70% of going rate (SW – option E)", "70% of going rate (SW – option J, GTR)", "70% of going rate (SW – option J)");
      const phd = parsePhd(row["Eligible for PhD points (SW)?"]);
      current = {
        socCode: match[1],
        relatedJobTitles: pickText(row, "Examples of related job titles (non-exclusive)", "Examples of related job titles (non- exclusive)", "Examples / title"),
        goingRate: rate.value,
        goingRate90: rate90.value,
        goingRate80: rate80.value,
        goingRate70: rate70.value,
        phdPointsEligible: phd,
        rateNote: [rate.note, rate70.note].filter(Boolean).join("; ") || null,
        raw: row,
      };
      results.push(current);
    } else if (codeText && current) {
      // Non-blank but unparseable code cell (e.g. a wrapped title
      // fragment like "and transport") - append to the open record's
      // job titles rather than guessing at a code.
      current.relatedJobTitles = [current.relatedJobTitles, codeText].filter(Boolean).join(" ");
    } else if (!codeText && current) {
      // Blank code cell - the classic continuation row, additional
      // job-title bullets wrapped onto their own line.
      const extra = pickText(row, "Examples of related job titles (non-exclusive)", "Examples of related job titles (non- exclusive)", "Examples / title");
      if (extra) current.relatedJobTitles = [current.relatedJobTitles, extra].filter(Boolean).join(" ");
    } else if (codeText && !current) {
      // Orphaned fragment with nothing open to attach it to - genuinely invalid.
      results.push({
        socCode: null,
        relatedJobTitles: "",
        goingRate: null,
        goingRate90: null,
        goingRate80: null,
        goingRate70: null,
        phdPointsEligible: null,
        rateNote: null,
        raw: row,
      });
    }
  }

  return results;
}

/** Table 4 (healthcare pay bands) and Table 5 (education pay scales)
 * have no soc_code column at all - pay-band/role by nation/region
 * matrices, parsed separately and stored as standalone reference data. */
export function parseHealthcarePayBands(sheet: XLSX.WorkSheet) {
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  return rows
    .filter((r) => r["Band or equivalent"])
    .map((r) => ({
      bandLabel: String(r["Band or equivalent"]).trim(),
      england: parseRate(r["England"]).value,
      scotland: parseRate(r["Scotland"]).value,
      wales: parseRate(r["Wales"]).value,
      northernIreland: parseRate(r["Northern Ireland"]).value,
    }));
}

export function parseEducationPayScales(sheet: XLSX.WorkSheet) {
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  return rows
    .filter((r) => r["Role"])
    .map((r) => ({
      roleLabel: String(r["Role"]).trim(),
      england: parseRate(r["England (excluding London / Fringe)"]).value,
      londonFringe: parseRate(r["London Fringe"]).value,
      outerLondon: parseRate(r["Outer London"]).value,
      innerLondon: parseRate(r["Inner London"]).value,
      scotland: parseRate(r["Scotland"]).value,
      wales: parseRate(r["Wales"]).value,
      northernIreland: parseRate(r["Northern Ireland"]).value,
    }));
}
