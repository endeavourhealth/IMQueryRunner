import { ErrorCode, JobStatus } from "~~/enums";
import { getJobForUser, getQueryResultIdForJob, getResultEntityIds } from "~~/server/helpers/mysqlHelper";

import { IMQType } from "@endeavour/vue-library/enums";

import { z } from "zod";

const paramSchema = z.object({
  jobId: z.coerce.number(),
  queryType: z.enum(IMQType),
  queryIri: z.string()
});

/** The distinct entity ids of a query's result, for comparing against an uploaded CSV. */
export default defineEventHandler(async event => {
  const { user } = await requireAuth(event);
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

  return getResultEntityIds(queryResultId, queryType);
});
