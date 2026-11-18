import { ArgumentSchema } from "@endeavour/vue-library/models";

import { z } from "zod";

/** What a comparison is against: the compared query's name and the arguments it ran with (a sub query's are its top level query's) */
export const ComparisonContextSchema = z.object({
  queryName: z.string(),
  arguments: z.array(ArgumentSchema)
});

export type ComparisonContext = z.output<typeof ComparisonContextSchema>;
