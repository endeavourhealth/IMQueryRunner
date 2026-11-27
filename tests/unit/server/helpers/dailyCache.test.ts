import { JobStatus } from "~~/enums";
import { jobRequestSchema } from "~~/models/jobRequest.schema";
import { copyResultRows, createResultSetEntry, findDailyCacheResult, getDayBounds } from "~~/server/helpers/mysqlHelper";

import { IMQType } from "@endeavour/vue-library/enums";

import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as any[][],
  calls: [] as { method: string; args: any[] }[],
  executed: [] as any[],
  affected: [] as number[],
  inserted: [] as any[]
}));

vi.mock("~~/server/db/mysql", () => {
  // Records each builder call with its arguments, then resolves to the next queued rows
  const chain: any = new Proxy(
    {},
    {
      get: (_, method: string) => {
        if (method === "then") return (res: any, rej: any) => Promise.resolve(state.rows.shift() ?? []).then(res, rej);
        return (...args: any[]) => {
          state.calls.push({ method, args });
          return chain;
        };
      }
    }
  );
  return {
    mysqlDb: {
      select: () => chain,
      execute: async (query: any) => {
        state.executed.push(query);
        return [{ affectedRows: state.affected.shift() ?? 0 }];
      },
      insert: () => ({
        values: async (values: any) => {
          state.inserted.push(values);
          return [{ insertId: 1 }];
        }
      })
    }
  };
});
vi.mock("#server/utils/queueEvents.ts", () => ({ emitQueueUpdate: vi.fn() }));
vi.mock("~~/server/services/QueryService", () => ({ default: {} }));
vi.mock("~~/server/utils/executeQuery", () => ({ hashQueryRequest: vi.fn(), resolveArgs: vi.fn(), sortQueryRequestsByDependency: vi.fn() }));

const dialect = new MySqlDialect();
const render = (fragment: any) => dialect.sqlToQuery(fragment);

beforeEach(() => {
  state.rows = [];
  state.calls.length = 0;
  state.executed.length = 0;
  state.affected = [];
  state.inserted.length = 0;
});

describe("jobRequestSchema", () => {
  it("turns the daily cache on by default", () => {
    const parsed = jobRequestSchema.parse({ jobName: "j", queryRequests: [] });
    expect(parsed.saveAsDailyCache).toBe(true);
    expect(parsed.useDailyCache).toBe(true);
  });

  it("lets a caller opt out of either flag", () => {
    const parsed = jobRequestSchema.parse({ jobName: "j", queryRequests: [], saveAsDailyCache: false, useDailyCache: false });
    expect(parsed.saveAsDailyCache).toBe(false);
    expect(parsed.useDailyCache).toBe(false);
  });

  it("rejects a flag that is not a boolean", () => {
    expect(() => jobRequestSchema.parse({ jobName: "j", queryRequests: [], useDailyCache: "yes" })).toThrow();
  });
});

describe("createResultSetEntry", () => {
  it("takes the daily cache flags from the job, not from the request", async () => {
    const request = {
      query: { iri: "http://example.org/q" },
      argument: [
        { parameter: "$searchDate", valueData: "2026-01-01" },
        { parameter: "$achievementDate", valueData: "2026-01-01" }
      ]
    };
    await createResultSetEntry(request, { id: 7, userId: "u", startOfDaySnapshot: 1, useStartOfDaySnapshot: 0 } as any);
    expect(state.inserted[0]).toMatchObject({ startOfDaySnapshot: 1, useStartOfDaySnapshot: 0 });
  });
});

describe("findDailyCacheResult", () => {
  it("matches on query, arguments, the cache flag, completion today and another job, but not on the user", async () => {
    state.rows = [[{ id: 9 }]];
    await expect(findDailyCacheResult("http://example.org/q", 123, "2026-11-26", 7)).resolves.toEqual({ id: 9 });

    const where = state.calls.find(call => call.method === "where")!.args[0];
    const { sql, params } = render(where);
    expect(sql).toContain("`query_result`.`query_iri` = ?");
    expect(sql).toContain("`query_result`.`version` = ?");
    expect(sql).toContain("`query_result`.`start_of_day_snapshot` = ?");
    expect(sql).toContain("`query_result`.`status` = ?");
    expect(sql).toContain("`query_result`.`end_time` >= ?");
    expect(sql).toContain("`query_result`.`end_time` < ?");
    expect(sql).toContain("`query_result_set`.`job_id` <> ?");
    expect(sql).not.toContain("user_id");
    // Written in UTC, like every end_time (drizzle stores Dates as UTC), so the day matches getToday()
    expect(params).toEqual(["http://example.org/q", 123, 1, JobStatus.COMPLETED, "2026-11-26 00:00:00.000", "2026-11-27 00:00:00.000", 7]);
  });

  it("takes the most recent match", async () => {
    await findDailyCacheResult("http://example.org/q", 123, "2026-11-26", 7);
    const methods = state.calls.map(call => call.method);
    expect(methods).toEqual(["from", "innerJoin", "where", "orderBy", "limit"]);
    expect(render(state.calls.find(call => call.method === "orderBy")!.args[0]).sql).toContain("desc");
    expect(state.calls.find(call => call.method === "limit")!.args[0]).toBe(1);
  });

  it("returns undefined on a miss", async () => {
    await expect(findDailyCacheResult("http://example.org/q", 123, "2026-11-26", 7)).resolves.toBeUndefined();
  });
});

describe("getDayBounds", () => {
  it("covers the whole UTC day", () => {
    const { start, end } = getDayBounds("2026-11-26");
    expect(start.toISOString()).toBe("2026-11-26T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-27T00:00:00.000Z");
  });
});

describe("copyResultRows", () => {
  it("copies a small cohort in one statement", async () => {
    state.rows = [[]]; // no boundary: everything left fits in one batch
    state.affected = [3];
    await expect(copyResultRows(900, 101, IMQType.COHORT)).resolves.toBe(3);
    expect(state.executed).toHaveLength(1);
    const { sql, params } = render(state.executed[0]);
    expect(sql).toBe(
      "INSERT INTO dataset.cohort_results (query_result_id, entity_id, entity_org_id) SELECT ?, entity_id, entity_org_id FROM dataset.cohort_results WHERE query_result_id = ?"
    );
    expect(params).toEqual([101, 900]);
  });

  it("copies a large result in entity id ranges", async () => {
    state.rows = [[{ entityId: 50 }], [{ entityId: 80 }], []];
    state.affected = [10000, 10000, 4];
    await expect(copyResultRows(900, 101, IMQType.DATASET)).resolves.toBe(20004);
    const queries = state.executed.map(render);
    expect(queries).toHaveLength(3);
    expect(queries[0]!.sql).toContain("(query_result_id, entity_id, column_group, json, entity_org_id)");
    expect(queries.map(query => query.params)).toEqual([
      [101, 900, 50],
      [101, 900, 50, 80],
      [101, 900, 80]
    ]);
    expect(queries[0]!.sql).toMatch(/entity_id <= \?$/);
    expect(queries[2]!.sql).toMatch(/entity_id > \?$/);
  });

  it("refuses a query type with no result rows", async () => {
    await expect(copyResultRows(900, 101, IMQType.INDICATOR)).rejects.toThrow();
  });
});
