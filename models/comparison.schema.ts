import { z } from "zod";

/** Whether one query (or sub query) returned a patient */
export const ComparisonQueryRowSchema = z.strictObject({
  queryIri: z.string(),
  queryName: z.string(),
  /** null when it is not known, e.g. the sub query did not run */
  found: z.boolean().nullable()
});

/** One patient in a comparison section: the compared query and each of its sub queries */
export const ComparisonPatientSchema = z.strictObject({
  entityId: z.string(),
  /** Not set until the query details for this patient have been loaded */
  query: ComparisonQueryRowSchema.extend({
    subQueries: z.array(ComparisonQueryRowSchema)
  }).optional()
});

export type ComparisonQueryRow = z.output<typeof ComparisonQueryRowSchema>;
export type ComparisonPatient = z.output<typeof ComparisonPatientSchema>;
