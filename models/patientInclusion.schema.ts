import { IMQType } from "@endeavour/vue-library/enums";
import { QueryRequestSchema } from "@endeavour/vue-library/models";

import { z } from "zod";

const patientId = z.coerce.number().int().positive();

export const PatientInclusionRequestSchema = z.union([
  z.object({
    patientId,
    queryRequest: QueryRequestSchema
  }),
  z.object({
    patientId,
    queryIri: z.url()
  })
]);

export type PatientInclusionRequest = z.output<typeof PatientInclusionRequestSchema>;

/** One query in a patient's inclusion tree: whether its result includes the patient, and the same for each of its sub queries */
export interface PatientInclusionNode {
  iri: string;
  name: string;
  queryType: IMQType;
  /** null when it is not known: an indicator (no result rows of its own) or a query that did not complete */
  found: boolean | null;
  children: PatientInclusionNode[];
}

export const PatientInclusionNodeSchema: z.ZodType<PatientInclusionNode> = z.strictObject({
  iri: z.url(),
  name: z.string(),
  queryType: z.enum(IMQType),
  found: z.boolean().nullable(),
  get children() {
    return z.array(PatientInclusionNodeSchema);
  }
});
