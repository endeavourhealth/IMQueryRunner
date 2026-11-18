import { JobStatus } from "~~/enums";
import { PatientInclusionNodeSchema } from "~~/models/patientInclusion.schema";
import { getPatientInclusionTree, loadJobResultSummaries } from "~~/server/helpers/patientInclusion";

import { IMQType } from "@endeavour/vue-library/enums";

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ responses: [] as any[][], distinct: [] as any[][] }));

vi.mock("~~/server/db/mysql", () => {
  // Every select() takes the next queued response when it is started, so queue order must match call order
  const chain = (response: any[]) => {
    const c: any = new Proxy({}, { get: (_, prop) => (prop === "then" ? (res: any, rej: any) => Promise.resolve(response).then(res, rej) : () => c) });
    return c;
  };
  return {
    mysqlDb: {
      select: () => chain(state.responses.shift() ?? []),
      selectDistinct: () => chain(state.distinct.shift() ?? [])
    }
  };
});
vi.mock("~~/server/utils/executeQuery", () => ({ hashQueryRequest: () => "hash" }));

vi.stubGlobal("createError", (opts: { status?: number; message?: string }) => Object.assign(new Error(opts.message), { statusCode: opts.status }));

const iri = (name: string) => `http://example.org/${name}`;
const entityName = async (queryIri: string) => `name of ${queryIri.split("/").pop()}`;

/** Indicator I (set 10) over cohort A; A uses cohort B and dataset C; B uses cohort D, which did not complete; C links back to A */
function queueJob() {
  state.responses = [
    [{ id: 10 }],
    [
      { id: 100, queryResultSetId: 10, indicatorResultId: 1, queryIri: iri("A"), queryType: IMQType.COHORT, status: JobStatus.COMPLETED },
      { id: 101, queryResultSetId: 10, indicatorResultId: null, queryIri: iri("B"), queryType: IMQType.COHORT, status: JobStatus.COMPLETED },
      { id: 102, queryResultSetId: 10, indicatorResultId: null, queryIri: iri("C"), queryType: IMQType.DATASET, status: JobStatus.COMPLETED },
      { id: 103, queryResultSetId: 10, indicatorResultId: null, queryIri: iri("D"), queryType: IMQType.COHORT, status: JobStatus.RUNNING }
    ],
    [{ id: 1, queryResultSetId: 10, queryIri: iri("I") }],
    [
      { parentQueryResultId: 100, subQueryResultId: 101 },
      { parentQueryResultId: 100, subQueryResultId: 102 },
      { parentQueryResultId: 101, subQueryResultId: 103 },
      { parentQueryResultId: 102, subQueryResultId: 100 }
    ]
  ];
}

describe("getPatientInclusionTree", () => {
  beforeEach(() => {
    state.responses = [];
    state.distinct = [];
  });

  it("returns the compared query with its sub queries nested, each marked found or not for the patient", async () => {
    queueJob();
    const summaries = await loadJobResultSummaries(1);
    // The patient is in A's cohort (B's is empty for them) and C's dataset
    state.distinct = [[{ id: 100 }], [{ id: 102 }]];

    const tree = await getPatientInclusionTree(1, 42, { queryIri: iri("A") }, summaries, entityName);

    expect(() => PatientInclusionNodeSchema.parse(tree)).not.toThrow();
    expect(tree).toEqual({
      iri: iri("A"),
      name: "name of A",
      found: true,
      children: [
        {
          iri: iri("B"),
          name: "name of B",
          found: false,
          children: [{ iri: iri("D"), name: "name of D", found: null, children: [] }]
        },
        // C links back to A, which is already on the path, so the cycle stops here
        { iri: iri("C"), name: "name of C", found: true, children: [] }
      ]
    });
  });

  it("roots an indicator at its directly linked results, with found unknown for the indicator itself", async () => {
    queueJob();
    const summaries = await loadJobResultSummaries(1);
    state.distinct = [[], []];

    const tree = await getPatientInclusionTree(1, 42, { queryIri: iri("I") }, summaries, entityName);

    expect(tree.found).toBeNull();
    expect(tree.children.map(child => child.iri)).toEqual([iri("A")]);
    expect(tree.children[0]!.found).toBe(false);
  });

  it("fails with 404 when the query is not in the job", async () => {
    queueJob();
    const summaries = await loadJobResultSummaries(1);
    await expect(getPatientInclusionTree(1, 42, { queryIri: iri("X") }, summaries, entityName)).rejects.toMatchObject({ statusCode: 404 });
  });
});
