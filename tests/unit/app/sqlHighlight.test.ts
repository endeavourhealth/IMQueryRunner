import { splitSqlByCte } from "~~/app/helpers/sqlHighlight";

import { describe, expect, it } from "vitest";

const marked = (sql: string, cte: string) => splitSqlByCte(sql, cte).filter(s => s.kind !== "text");

describe("splitSqlByCte", () => {
  const sql = `WITH step_1 AS (SELECT id FROM patient),
step_10 AS (SELECT id FROM step_1),
\`step_2\` (id) AS (SELECT s.id FROM step_1 s JOIN step_10 t ON t.id = s.id)
SELECT * FROM step_2`;

  it("returns the whole text when there is nothing to highlight", () => {
    expect(splitSqlByCte(sql, null)).toEqual([{ text: sql, kind: "text" }]);
    expect(splitSqlByCte("", "step_1")).toEqual([]);
  });

  it("marks the definition and every reference, without matching longer identifiers", () => {
    expect(marked(sql, "step_1")).toEqual([
      { text: "step_1", kind: "definition" },
      { text: "step_1", kind: "reference" },
      { text: "step_1", kind: "reference" }
    ]);
  });

  it("recognises quoted definitions with a column list", () => {
    expect(marked(sql, "step_2").map(s => s.kind)).toEqual(["definition", "reference"]);
  });

  it("matches case-insensitively and keeps the text intact", () => {
    const segments = splitSqlByCte(sql, "STEP_10");
    expect(segments.map(s => s.text).join("")).toBe(sql);
    expect(segments.filter(s => s.kind !== "text").map(s => s.kind)).toEqual(["definition", "reference"]);
  });

  it("escapes regex characters in the name", () => {
    expect(marked("WITH a.b AS (SELECT 1) SELECT * FROM axb, a.b", "a.b").map(s => s.kind)).toEqual(["definition", "reference"]);
  });
});
