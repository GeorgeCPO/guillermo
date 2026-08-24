import { z } from "zod";

export const ProjectKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,49}$/);

const IssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/);
const JiraIdSchema = z.union([
  z.string().regex(/^[1-9][0-9]*$/),
  z.number().int().safe().positive(),
]);

export const JiraPayloadObjectSchema = z.looseObject({
  webhookEvent: z.unknown().optional(),
});

export const JiraEnvelopeSchema = z.looseObject({
  issue: z.looseObject({ fields: z.looseObject({}) }),
  comment: z.looseObject({}),
});

export const TrustedIssueFieldsSchema = z.looseObject({
  issue: z.looseObject({
    key: IssueKeySchema,
    fields: z.looseObject({
      project: z.looseObject({ key: ProjectKeySchema }),
      summary: z.string().refine((value) => value.trim().length > 0),
      description: z.unknown().optional(),
    }),
  }),
  comment: z.looseObject({
    id: JiraIdSchema,
    body: z.unknown().optional(),
  }),
});
