import { ErrorCode } from "~~/enums";
import { PatientInclusionNodeSchema, PatientInclusionRequestSchema } from "~~/models/patientInclusion.schema";
import { createLookups } from "~~/server/helpers/jobSummaries";
import { getJobForUser } from "~~/server/helpers/mysqlHelper";
import { getPatientInclusionTree, loadJobResultSummaries } from "~~/server/helpers/patientInclusion";

import { z } from "zod";

const paramSchema = z.object({
  jobId: z.coerce.number()
});

/** Which of a query's results (the query and each of its sub queries, as a tree) include one patient. */
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

  // A name that cannot be looked up shows its iri rather than failing the whole tree
  const nameOrIri = (iri: string) =>
    entityName(iri).then(
      name => name || iri,
      () => iri
    );

  return PatientInclusionNodeSchema.parse(await getPatientInclusionTree(job.id, patientId, rootQuery, summaries, nameOrIri));
});
