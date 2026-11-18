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

export interface PatientInclusionNode {
  iri: string;
  name: string;
  found: boolean | null;
  children: PatientInclusionNode[];
}
