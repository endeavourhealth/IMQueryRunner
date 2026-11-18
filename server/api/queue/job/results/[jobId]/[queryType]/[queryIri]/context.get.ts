import { ErrorCode, JobStatus } from "~~/enums";
import { ComparisonContextSchema } from "~~/models/comparisonContext.schema";
import { createLookups } from "~~/server/helpers/jobSummaries";
import { getJobForUser, getQueryRequestIndexForResult, getQueryResultIdForJob } from "~~/server/helpers/mysqlHelper";

import { IMQType } from "@endeavour/vue-library/enums";

import { z } from "zod";

const paramSchema = z.object({
  jobId: z.coerce.number(),
  queryType: z.enum(IMQType),
  queryIri: z.string()
});

/**
 * The name and arguments of a query being compared against an uploaded CSV. The query is a request of the job or one of its sub queries:
 * a sub query is not a request itself, so it ran with the arguments of the request it belongs to. Picks the same result as the ids endpoint.
 */
export default defineEventHandler(async event => {
  const { user } = await requireAuth(event);
  const accessToken = await getAccessToken(event);
  const { jobId, queryIri, queryType } = await getValidatedRouterParams(event, paramSchema.parse);
  const decodedQueryIri = decodeURIComponent(queryIri);

  const job = await getJobForUser(jobId, user.id);

  if (queryType === IMQType.INDICATOR) {
    throw createError({ statusCode: 400, statusText: ErrorCode.InvalidRequestError, message: "Indicator results cannot be compared" });
  }
  const queryResultId = await getQueryResultIdForJob(job.id, decodedQueryIri);
  if (queryResultId === undefined) {
    if (job.status !== JobStatus.COMPLETED) {
      throw createError({ statusCode: 409, statusText: ErrorCode.InvalidRequestError, message: "This query has not completed, so it has no results" });
    }
    throw createError({ statusCode: 404, statusText: ErrorCode.MissingDataError, message: "Query result not found" });
  }

  const index = await getQueryRequestIndexForResult(job.id, queryResultId);
  const queryRequest = index === undefined ? undefined : job.queryRequests[index];
  if (!queryRequest) throw createError({ statusCode: 404, statusText: ErrorCode.MissingDataError, message: "Query request not found for this result" });

  // A request's own query has its name stored with the job; a sub query's is looked up
  const isRequestQuery = queryRequest.query?.iri === decodedQueryIri;
  const { entityName } = createLookups(accessToken, user.id);
  const queryName = (isRequestQuery && queryRequest.query?.name) || (await entityName(decodedQueryIri).catch(() => "")) || decodedQueryIri;

  return ComparisonContextSchema.parse({ queryName, arguments: queryRequest.argument ?? [] });
});
