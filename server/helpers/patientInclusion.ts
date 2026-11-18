import { subQueryLookup } from "#shared/queryReport";
import { ErrorCode, JobStatus } from "~~/enums";
import type { QueryResultSummary } from "~~/models";
import type { PatientInclusionNode } from "~~/models/patientInclusion.schema";

import { IMQType } from "@endeavour/vue-library/enums";
import type { QueryRequest } from "@endeavour/vue-library/models";

import { and, asc, eq, inArray } from "drizzle-orm";

import { mysqlDb } from "../db/mysql";
import { cohortResultsTable, datasetResultsTable, indicatorResultTable, queryDependencyTable, queryResultSetTable, queryResultTable } from "../db/mysql/schema";
import { hashQueryRequest } from "../utils/executeQuery";

export type RootQuery = { queryRequest: QueryRequest } | { queryIri: string };
export type EntityName = (iri: string) => Promise<string>;

export async function loadJobResultSummaries(jobId: number): Promise<QueryResultSummary[]> {
  const resultSets = await mysqlDb
    .select({ id: queryResultSetTable.id })
    .from(queryResultSetTable)
    .where(eq(queryResultSetTable.jobId, jobId))
    .orderBy(asc(queryResultSetTable.id));
  const setIds = resultSets.map(set => set.id);
  if (!setIds.length) return [];

  const [rows, indicators] = await Promise.all([
    mysqlDb
      .select({
        id: queryResultTable.id,
        queryResultSetId: queryResultTable.queryResultSetId,
        indicatorResultId: queryResultTable.indicatorResultId,
        queryIri: queryResultTable.queryIri,
        queryType: queryResultTable.queryType,
        status: queryResultTable.status
      })
      .from(queryResultTable)
      .where(inArray(queryResultTable.queryResultSetId, setIds))
      .orderBy(asc(queryResultTable.id)),
    mysqlDb
      .select({ id: indicatorResultTable.id, queryResultSetId: indicatorResultTable.queryResultSetId, queryIri: indicatorResultTable.queryIri })
      .from(indicatorResultTable)
      .where(inArray(indicatorResultTable.queryResultSetId, setIds))
  ]);
  const dependencies = rows.length
    ? await mysqlDb
        .select()
        .from(queryDependencyTable)
        .where(
          inArray(
            queryDependencyTable.parentQueryResultId,
            rows.map(row => row.id)
          )
        )
    : [];

  const subQueryResultIdsById = Map.groupBy(dependencies, dependency => dependency.parentQueryResultId);
  const rowsBySetId = Map.groupBy(rows, row => row.queryResultSetId);
  const indicatorsBySetId = Map.groupBy(indicators, indicator => indicator.queryResultSetId);
  const blank = { totalCount: null, queryName: "", startTime: null, endTime: null };

  return setIds.flatMap(setId => [
    ...(indicatorsBySetId.get(setId) ?? []).map((indicator): QueryResultSummary => ({
      ...blank,
      indicatorResultId: indicator.id,
      queryIri: indicator.queryIri,
      queryType: IMQType.INDICATOR,
      status: JobStatus.COMPLETED
    })),
    ...(rowsBySetId.get(setId) ?? []).map((row): QueryResultSummary => {
      const summary: QueryResultSummary = { ...blank, queryResultId: row.id, queryIri: row.queryIri, queryType: row.queryType, status: row.status };
      const links = subQueryResultIdsById.get(row.id);
      if (links) summary.subQueryResultIds = links.map(link => link.subQueryResultId);
      if (row.indicatorResultId !== null) summary.indicatorResultId = row.indicatorResultId;
      return summary;
    })
  ]);
}

function findSummaryByIri(iri: string, summaries: QueryResultSummary[]): QueryResultSummary {
  const ofIri = summaries.filter(summary => summary.queryIri === iri);
  const root = ofIri.find(summary => summary.queryResultId !== undefined && summary.status === JobStatus.COMPLETED) ?? ofIri[0];
  if (!root) throw createError({ status: 404, statusText: ErrorCode.MissingDataError, message: "No result for this query in the job" });
  return root;
}

async function findSummaryByRequest(jobId: number, queryRequest: QueryRequest, summaries: QueryResultSummary[]): Promise<QueryResultSummary> {
  const iri = queryRequest.query?.iri;
  if (!iri) throw createError({ status: 400, statusText: ErrorCode.InvalidRequestError, message: "Query IRI is required" });
  const version = hashQueryRequest(queryRequest);

  const [queryResults, indicatorResults] = await Promise.all([
    mysqlDb
      .select({ id: queryResultTable.id })
      .from(queryResultTable)
      .innerJoin(queryResultSetTable, eq(queryResultTable.queryResultSetId, queryResultSetTable.id))
      .where(and(eq(queryResultSetTable.jobId, jobId), eq(queryResultTable.queryIri, iri), eq(queryResultTable.version, version))),
    mysqlDb
      .select({ id: indicatorResultTable.id })
      .from(indicatorResultTable)
      .innerJoin(queryResultSetTable, eq(indicatorResultTable.queryResultSetId, queryResultSetTable.id))
      .where(and(eq(queryResultSetTable.jobId, jobId), eq(indicatorResultTable.queryIri, iri), eq(indicatorResultTable.version, version)))
  ]);

  const queryResultIds = new Set(queryResults.map(row => row.id));
  const indicatorResultIds = new Set(indicatorResults.map(row => row.id));
  const root =
    summaries.find(summary => summary.queryResultId !== undefined && queryResultIds.has(summary.queryResultId)) ??
    summaries.find(summary => summary.queryType === IMQType.INDICATOR && indicatorResultIds.has(summary.indicatorResultId!));
  if (!root) {
    throw createError({ status: 404, statusText: ErrorCode.MissingDataError, message: "No result for this query and arguments in the job" });
  }
  return root;
}

export function findRootSummary(jobId: number, rootQuery: RootQuery, summaries: QueryResultSummary[]): Promise<QueryResultSummary> {
  if ("queryIri" in rootQuery) return Promise.resolve(findSummaryByIri(rootQuery.queryIri, summaries));
  return findSummaryByRequest(jobId, rootQuery.queryRequest, summaries);
}

function collectSummaries(root: QueryResultSummary, subQueriesOf: (summary: QueryResultSummary) => QueryResultSummary[]): QueryResultSummary[] {
  const seen = new Set([root]);
  const order = [root];
  for (const summary of order) {
    for (const sub of subQueriesOf(summary)) {
      if (!seen.has(sub)) {
        seen.add(sub);
        order.push(sub);
      }
    }
  }
  return order;
}

async function resultIdsIncludingPatient(patientId: number, summaries: QueryResultSummary[]): Promise<Set<number>> {
  const idsOfType = (type: IMQType) =>
    summaries
      .filter(summary => summary.queryType === type && summary.status === JobStatus.COMPLETED && summary.queryResultId !== undefined)
      .map(summary => summary.queryResultId!);
  const cohortIds = idsOfType(IMQType.COHORT);
  const datasetIds = idsOfType(IMQType.DATASET);

  const [cohortRows, datasetRows] = await Promise.all([
    cohortIds.length
      ? mysqlDb
          .selectDistinct({ id: cohortResultsTable.queryResultId })
          .from(cohortResultsTable)
          .where(and(inArray(cohortResultsTable.queryResultId, cohortIds), eq(cohortResultsTable.entityId, patientId)))
      : [],
    datasetIds.length
      ? mysqlDb
          .selectDistinct({ id: datasetResultsTable.queryResultId })
          .from(datasetResultsTable)
          .where(and(inArray(datasetResultsTable.queryResultId, datasetIds), eq(datasetResultsTable.entityId, patientId)))
      : []
  ]);
  return new Set([...cohortRows, ...datasetRows].map(row => row.id));
}

function found(summary: QueryResultSummary, includingPatient: Set<number>): boolean | null {
  if (summary.queryType === IMQType.INDICATOR || summary.queryResultId === undefined) return null;
  if (summary.status !== JobStatus.COMPLETED) return null;
  return includingPatient.has(summary.queryResultId);
}

export async function getPatientInclusionTree(
  jobId: number,
  patientId: number,
  rootQuery: RootQuery,
  summaries: QueryResultSummary[],
  entityName: EntityName
): Promise<PatientInclusionNode> {
  const root = await findRootSummary(jobId, rootQuery, summaries);
  const subQueriesOf = subQueryLookup(summaries);
  const inTree = collectSummaries(root, subQueriesOf);
  const iris = [...new Set(inTree.map(summary => summary.queryIri))];
  const [includingPatient, names] = await Promise.all([
    resultIdsIncludingPatient(patientId, inTree),
    Promise.all(iris.map(async iri => [iri, await entityName(iri)] as const)).then(entries => new Map(entries))
  ]);

  const build = (summary: QueryResultSummary, ancestors: Set<QueryResultSummary>): PatientInclusionNode => {
    const path = new Set(ancestors).add(summary);
    return {
      iri: summary.queryIri,
      name: names.get(summary.queryIri) ?? "",
      found: found(summary, includingPatient),
      children: subQueriesOf(summary)
        .filter(sub => !path.has(sub))
        .map(sub => build(sub, path))
    };
  };
  return build(root, new Set());
}
