import { JobStatus } from "~~/enums";
import { DELETE_BATCH_SIZE, deleteAllJobsForUser, deleteJobData } from "~~/server/helpers/mysqlHelper";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selects: [] as any[][],
  batchAffected: [] as number[],
  deletes: [] as string[],
  transactionDeletes: [] as string[]
}));

vi.mock("~~/server/db/mysql", () => {
  const deleter = (log: string[], withLimit: boolean) => (table: any) => ({
    where: () => {
      const name = getTableName(table);
      if (!withLimit) {
        log.push(name);
        return Promise.resolve();
      }
      return {
        limit: () => {
          log.push(name);
          return Promise.resolve([{ affectedRows: state.batchAffected.shift() ?? 0 }]);
        }
      };
    }
  });
  return {
    mysqlDb: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(state.selects.shift() ?? []) }) }),
      delete: deleter(state.deletes, true),
      transaction: async (cb: (tx: unknown) => Promise<void>) => cb({ delete: deleter(state.transactionDeletes, false) })
    }
  };
});
const { emitQueueUpdate } = vi.hoisted(() => ({ emitQueueUpdate: vi.fn() }));
vi.mock("#server/utils/queueEvents.ts", () => ({ emitQueueUpdate }));
vi.mock("~~/server/services/EntityService", () => ({ default: {} }));
vi.mock("~~/server/services/QueryService", () => ({ default: {} }));
vi.mock("~~/server/utils/executeQuery", () => ({ resolveArgs: vi.fn(), sortQueryRequestsByDependency: vi.fn() }));

vi.stubGlobal("createError", (opts: { status?: number; statusCode?: number; message?: string }) =>
  Object.assign(new Error(opts.message), { statusCode: opts.statusCode ?? opts.status })
);

const job = (status: JobStatus) => ({ id: 5, status }) as any;

describe("deleteJobData", () => {
  beforeEach(() => {
    state.selects = [];
    state.batchAffected = [];
    state.deletes.length = 0;
    state.transactionDeletes.length = 0;
  });

  it("refuses to delete a running job", async () => {
    await expect(deleteJobData(job(JobStatus.RUNNING))).rejects.toMatchObject({ statusCode: 409 });
    expect(state.deletes).toEqual([]);
    expect(state.transactionDeletes).toEqual([]);
  });

  it("only deletes the job when it has no result sets", async () => {
    state.selects = [[]];
    await deleteJobData(job(JobStatus.QUEUED));
    expect(state.deletes).toEqual([]);
    expect(state.transactionDeletes).toEqual(["job"]);
  });

  it("clears cohort and dataset rows in batches, then deletes metadata child-first", async () => {
    state.selects = [[{ id: 1 }], [{ id: 10 }, { id: 11 }]];
    // cohort_results: one full batch then a partial one; dataset_results: a single partial batch
    state.batchAffected = [DELETE_BATCH_SIZE, 3, 0];
    await deleteJobData(job(JobStatus.COMPLETED));
    expect(state.deletes).toEqual(["cohort_results", "cohort_results", "dataset_results"]);
    expect(state.transactionDeletes).toEqual(["query_dependency", "query_result", "indicator_result", "query_result_set", "job"]);
  });
});

describe("deleteAllJobsForUser", () => {
  beforeEach(() => {
    state.selects = [];
    state.batchAffected = [];
    state.deletes.length = 0;
    state.transactionDeletes.length = 0;
    emitQueueUpdate.mockClear();
  });

  it("deletes every job that is not running and reports running ones as skipped", async () => {
    // the user's jobs, then one empty result-set lookup per deleted job
    state.selects = [
      [
        { id: 1, status: JobStatus.COMPLETED },
        { id: 2, status: JobStatus.RUNNING },
        { id: 3, status: JobStatus.QUEUED }
      ],
      [],
      []
    ];
    await expect(deleteAllJobsForUser("user-1")).resolves.toEqual({ deleted: 2, skipped: 1 });
    expect(state.transactionDeletes).toEqual(["job", "job"]);
    expect(emitQueueUpdate).toHaveBeenCalledWith("user-1");
  });

  it("does nothing when the user has no jobs", async () => {
    state.selects = [[]];
    await expect(deleteAllJobsForUser("user-1")).resolves.toEqual({ deleted: 0, skipped: 0 });
    expect(state.transactionDeletes).toEqual([]);
    expect(emitQueueUpdate).not.toHaveBeenCalled();
  });
});
