import type { QueryRequest } from "@endeavour/vue-library/models";

export interface JobRequest {
  jobName: string;
  queryRequests: QueryRequest[];
  saveAsDailyCache: boolean;
  persistent: boolean;
  useDailyCache: boolean;
}
