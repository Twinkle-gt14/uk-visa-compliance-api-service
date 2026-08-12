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
/** Signature of a shifted row in a "7-column-style" table (Table 1,
 * 1a, 2): the workbook's own "Equivalent SOC 2010 occupation code(s)"
 * value has landed in the job-titles slot because that column isn't
 * declared in the header row for these three tables specifically -
 * confirmed present in Table 2's data (88 of 92 rows) despite its
 * header only listing 7 columns, while Table 2aa/2a/2b/3/3a all
 * declare that column properly and never hit this path. Detecting by
 * value shape (a bare code list) rather than assuming any one table
 * name is fixed makes this self-correcting if the same quirk shows up
 * in a future version of the workbook, rather than a one-off patch. */
const SOC_CODE_LIST_PATTERN = /^\d{4}(,\s*\d{4})*$/;

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
  return { value: null, note: text };
}

function parsePhd(cell: unknown): boolean | null {
  if (cell == null) return null;
  const text = String(cell).trim().toLowerCase();
  if (text === "yes") return true;
  if (text === "no") return false;
  return null; // "Not applicable" or blank - genuinely unknown, not false
}

function cellText(row: unknown[], idx: number): string {
  const v = row[idx];
  return v == null ? "" : String(v).trim();
}

/** Finds a header cell's column index by regex, tolerating the minor
 * text variations already confirmed between tables (e.g. a stray
 * space before the hyphen in "non- exclusive" vs "non-exclusive"). */
function findHeaderIndex(header: unknown[], pattern: RegExp): number {
  return header.findIndex((h) => h != null && pattern.test(String(h)));
}

/** Parses one Appendix table sheet into ParsedAppendixRow[]. Handles:
 * - SOC code + title concatenated in the first cell ("1111 Chief executives...")
 * - continuation rows (blank/unparseable code cell) - appended to
 *   whichever record is currently open
 * - the Table 2-style column shift (see SOC_CODE_LIST_PATTERN above),
 *   detected and corrected per row rather than assumed for a whole sheet
 * - genuinely orphaned fragments (no open record to attach to) -
 *   returned with socCode: null so the caller can bucket them Invalid
 */
export function parseAppendixTable(sheet: XLSX.WorkSheet): ParsedAppendixRow[] {
  const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
  if (!allRows.length) return [];
  const header = allRows[0];
  const dataRows = allRows.slice(1);

  const codeIdx = findHeaderIndex(header, /soc.*2020.*occupation.*code/i);
  if (codeIdx === -1) return [];

  // If the header already declares the SOC2010-equivalent column
  // (Table 2aa/2a/2b/3/3a all do), locate every field by its own
  // header text - the shift never applies to these tables.
  const soc2010DeclaredIdx = findHeaderIndex(header, /equivalent.*soc.*2010/i);
  const jobTitlesIdx = findHeaderIndex(header, /examples.*related job titles|examples\s*\/\s*title/i);
  const goingRateIdx = findHeaderIndex(header, /^going rate/i);
  const rate90Idx = findHeaderIndex(header, /90%.*going rate/i);
  const rate80Idx = findHeaderIndex(header, /80%.*going rate/i);
  const rate70Idx = findHeaderIndex(header, /70%.*going rate/i);
  const phdIdx = findHeaderIndex(header, /eligible for phd points/i);

  const results: ParsedAppendixRow[] = [];
  let current: ParsedAppendixRow | null = null;

  for (const row of dataRows) {
    const codeText = cellText(row, codeIdx);
    const match = codeText.match(SOC_CODE_PATTERN);

    if (match) {
      // Detect a per-row shift: only possible/relevant when the
      // header itself doesn't already declare the SOC2010 column, and
      // only when the job-titles slot's actual content looks like a
      // bare code list rather than descriptive text.
      const canShift = soc2010DeclaredIdx === -1 && jobTitlesIdx !== -1;
      const shifted = canShift && SOC_CODE_LIST_PATTERN.test(cellText(row, jobTitlesIdx));
      const offset = shifted ? 1 : 0;

      const rate = parseRate(row[goingRateIdx + offset]);
      const rate90 = parseRate(row[rate90Idx + offset]);
      const rate80 = parseRate(row[rate80Idx + offset]);
      const rate70 = parseRate(row[rate70Idx + offset]);
      // When shifted, the true PhD value sits one column past what the
      // header declares - recoverable here because this parser reads
      // positionally, unlike a header-keyed read which would drop it
      // (no header label exists for that extra column).
      const phd = parsePhd(row[phdIdx + offset]);

      current = {
        socCode: match[1],
        relatedJobTitles: jobTitlesIdx === -1 ? "" : cellText(row, jobTitlesIdx + offset),
        goingRate: rate.value,
        goingRate90: rate90.value,
        goingRate80: rate80.value,
        goingRate70: rate70.value,
        phdPointsEligible: phd,
        rateNote: [rate.note, rate70.note].filter(Boolean).join("; ") || null,
        raw: Object.fromEntries(header.map((h, i) => [h ?? `col_${i}`, row[i] ?? null])),
      };
      results.push(current);
    } else if (codeText && current) {
      // Wrapped title fragment landed in the code column - append to
      // the open record rather than guessing at a code.
      current.relatedJobTitles = [current.relatedJobTitles, codeText].filter(Boolean).join(" ");
    } else if (!codeText && current) {
      // Blank code cell - the classic continuation row.
      const extra = jobTitlesIdx === -1 ? "" : cellText(row, jobTitlesIdx);
      if (extra) current.relatedJobTitles = [current.relatedJobTitles, extra].filter(Boolean).join(" ");
    } else if (codeText && !current) {
      // Orphaned fragment with nothing open to attach it to.
      results.push({
        socCode: null,
        relatedJobTitles: "",
        goingRate: null,
        goingRate90: null,
        goingRate80: null,
        goingRate70: null,
        phdPointsEligible: null,
        rateNote: null,
        raw: Object.fromEntries(header.map((h, i) => [h ?? `col_${i}`, row[i] ?? null])),
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
