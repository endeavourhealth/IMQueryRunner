import { ErrorCode } from "~~/enums";
import { PatientInclusionRequestSchema } from "~~/models/patientInclusion.schema";
import { createLookups } from "~~/server/helpers/jobSummaries";
import { getJobForUser } from "~~/server/helpers/mysqlHelper";
import { getPatientInclusionTree, loadJobResultSummaries } from "~~/server/helpers/patientInclusion";

import { z } from "zod";

const paramSchema = z.object({
  jobId: z.coerce.number()
});

export default defineEventHandler(async event => {
  const { user } = await requireAuth(event);
  const accessToken = await getAccessToken(event);
  const { jobId } = await getValidatedRouterParams(event, paramSchema.parse);
  const body = PatientInclusionRequestSchema.safeParse(await readBody(event));
  if (!body.success) {
    throw createError({
      status: 400,
      statusText: ErrorCode.InvalidRequestError,
      message: "A patient id and either a query request or a query iri are required"
    });
  }
  const { patientId, ...rootQuery } = body.data;

  const job = await getJobForUser(jobId, user.id);
  const summaries = await loadJobResultSummaries(job.id);
  const { entityName } = createLookups(accessToken, user.id);

  return getPatientInclusionTree(job.id, patientId, rootQuery, summaries, entityName);
});
