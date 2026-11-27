import { type QueryRequest, QueryRequestSchema } from "@endeavour/vue-library/models";

import * as z from "zod";

export const jobRequestSchema = z.object({
  jobName: z.string(),
  queryRequests: z.array(QueryRequestSchema),
  /** Every result the job completes can be reused as daily cache by later jobs, whoever runs them (see docs/DAILY_CACHE.MD) */
  saveAsDailyCache: z.boolean().default(true),
  persistent: z.boolean().default(false),
  /** Sub queries reuse a matching daily-cache result instead of running. The job's own (top-level) queries always run */
  useDailyCache: z.boolean().default(true)
});

export interface JobRequest {
  jobName: string;
  queryRequests: QueryRequest[];
  saveAsDailyCache: boolean;
  persistent: boolean;
  useDailyCache: boolean;
}
