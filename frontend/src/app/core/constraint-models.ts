import { z } from 'zod';
import { StopSchema } from './models';

export const ConstraintKindSchema = z.enum([
  'budget_max', 'day_start_min', 'day_end_max', 'walking_max',
  'max_activities', 'interest', 'include_place', 'exclude_place',
]);
export const ConstraintRecordSchema = z.object({
  id: z.string(), ownerId: z.string(), kind: ConstraintKindSchema,
  value: z.union([z.number().finite(), z.string()]), hard: z.boolean(),
  sourceQuestionId: z.string().nullable().default(null),
});
export const ConstraintAnswerSchema = z.object({
  questionId: z.string(), questionVersion: z.literal(1),
  choice: z.enum(['A', 'B', 'indifferent']), createdAt: z.number(),
});
export const MemberConstraintSessionSchema = z.object({
  uid: z.string(), schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  confirmed: z.boolean(), answers: z.array(ConstraintAnswerSchema),
  answerHistory: z.array(ConstraintAnswerSchema).default([]),
  constraints: z.array(ConstraintRecordSchema), updatedAt: z.number(),
});
export const SolverPlaceSchema = z.object({
  id: z.string(), title: z.string(), category: z.enum(['food', 'sight', 'activity', 'free']),
  durationMinutes: z.number(), cost: z.number(), openMinute: z.number(), closeMinute: z.number(),
  lat: z.number(), lng: z.number(), tags: z.array(z.string()),
});
export const SolverCatalogSchema = z.object({
  id: z.string(), destination: z.string(), currency: z.string(),
  costUnit: z.string(), timezone: z.string(), description: z.string(), places: z.array(SolverPlaceSchema),
});
export const SolverProposalSchema = z.object({
  id: z.string(), tripId: z.string(), inputVersion: z.string(), catalogId: z.string(),
  summary: z.string(), stops: z.array(StopSchema).min(1).max(15)
    .refine(stops => new Set(stops.map(s => s.id)).size === stops.length, 'Proposal stop IDs must be unique.'),
  warnings: z.array(z.string()),
  memberScores: z.array(z.object({ uid: z.string(), score: z.number() })),
});
export const SolverResponseSchema = z.object({
  status: z.enum(['sat', 'unsat', 'unknown', 'insufficient_data', 'incomplete']),
  proposal: SolverProposalSchema.nullable(),
  conflicts: z.array(z.object({ constraintId: z.string(), ownerId: z.string(), message: z.string() })),
  explanations: z.array(z.string()),
}).superRefine((response, context) => {
  if ((response.status === 'sat') !== (response.proposal !== null)) {
    context.addIssue({ code: 'custom', message: 'A feasible result must include a proposal; other results must not include one.', path: ['proposal'] });
  }
});
export type ConstraintKind = z.infer<typeof ConstraintKindSchema>;
export type ConstraintRecord = z.infer<typeof ConstraintRecordSchema>;
export type ConstraintAnswer = z.infer<typeof ConstraintAnswerSchema>;
export type MemberConstraintSession = z.infer<typeof MemberConstraintSessionSchema>;
export type SolverCatalog = z.infer<typeof SolverCatalogSchema>;
export type SolverProposal = z.infer<typeof SolverProposalSchema>;
export type SolverResponse = z.infer<typeof SolverResponseSchema>;
