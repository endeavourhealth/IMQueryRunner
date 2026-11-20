export type SqlSegmentKind = "text" | "definition" | "reference";

export interface SqlSegment {
  text: string;
  kind: SqlSegmentKind;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits `sql` around every occurrence of the CTE `cteName` as a whole identifier (case-insensitive, bare or backtick-quoted).
 * The occurrence that declares it (`name AS (` or `name (cols) AS (`) is a "definition"; every other one is a "reference".
 */
export function splitSqlByCte(sql: string, cteName: string | null | undefined): SqlSegment[] {
  if (!sql) return [];
  if (!cteName) return [{ text: sql, kind: "text" }];

  const identifier = new RegExp(`(?<![\\w$])${escapeRegExp(cteName)}(?![\\w$])`, "gi");
  const declaration = /^`?\s*(\([^)]*\)\s*)?AS\s*\(/i;
  const segments: SqlSegment[] = [];
  let last = 0;
  for (const match of sql.matchAll(identifier)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > last) segments.push({ text: sql.slice(last, start), kind: "text" });
    const kind = declaration.test(sql.slice(end).trimStart()) ? "definition" : "reference";
    segments.push({ text: match[0], kind });
    last = end;
  }
  if (last < sql.length) segments.push({ text: sql.slice(last), kind: "text" });
  return segments;
}
