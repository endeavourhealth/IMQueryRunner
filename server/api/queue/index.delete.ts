import Logger from "#shared/logger";
import { deleteAllJobsForUser } from "~~/server/helpers/mysqlHelper";

const LOG = Logger("api/queue/delete");

/** Clears the signed-in user's queue: every job of theirs and all its results. Running jobs are skipped and counted. */
export default defineEventHandler(async event => {
  const { user } = await requireAuth(event);
  LOG.info(`Clearing all jobs for user ${user.id}`);
  return await deleteAllJobsForUser(user.id);
});
