import { getQueryRequestIndexForResult } from "~~/server/helpers/mysqlHelper";

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ responses: [] as any[][] }));

vi.mock("~~/server/db/mysql", () => {
  // Every select() takes the next queued response when it is started, so queue order must match call order
  const chain = (response: any[]) => {
    const c: any = new Proxy({}, { get: (_, prop) => (prop === "then" ? (res: any, rej: any) => Promise.resolve(response).then(res, rej) : () => c) });
    return c;
  };
  return { mysqlDb: { select: () => chain(state.responses.shift() ?? []) } };
});
vi.mock("#server/utils/queueEvents.ts", () => ({ emitQueueUpdate: vi.fn() }));
vi.mock("~~/server/services/EntityService", () => ({ default: {} }));
vi.mock("~~/server/services/QueryService", () => ({ default: {} }));
vi.mock("~~/server/utils/executeQuery", () => ({ hashQueryRequest: vi.fn(), resolveArgs: vi.fn(), sortQueryRequestsByDependency: vi.fn() }));

describe("getQueryRequestIndexForResult", () => {
  beforeEach(() => {
    state.responses = [];
  });

  it("is the position of the result's set among the job's sets, which planJob creates in request order", async () => {
    // The job's sets (ordered by id), then the result's row: a sub query result in the second request's set
    state.responses = [[{ id: 10 }, { id: 11 }, { id: 12 }], [{ queryResultSetId: 11 }]];
    await expect(getQueryRequestIndexForResult(1, 500)).resolves.toBe(1);
  });

  it("is undefined when the result is not in one of the job's sets", async () => {
    state.responses = [[{ id: 10 }], [{ queryResultSetId: 99 }]];
    await expect(getQueryRequestIndexForResult(1, 500)).resolves.toBeUndefined();
  });

  it("is undefined when the result does not exist", async () => {
    state.responses = [[{ id: 10 }], []];
    await expect(getQueryRequestIndexForResult(1, 500)).resolves.toBeUndefined();
  });
});
