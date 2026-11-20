import { z } from "zod";

/** One patient in a comparison section. Their inclusion tree (the compared query and its sub queries) is loaded when the row is expanded */
export const ComparisonPatientSchema = z.strictObject({
  entityId: z.string()
});

export type ComparisonPatient = z.output<typeof ComparisonPatientSchema>;
