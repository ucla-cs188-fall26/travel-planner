import { z } from 'zod';

// Destination-local time with no timezone
const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);

//Real world location tagged with a stop
export const PlaceSchema = z.object({
  name: z.string(),
  placeId: z.string().optional(),   
  lat: z.number().optional(),
  lng: z.number().optional(),
  address: z.string().optional(),
});

//Itinerary item shown on the calendar and map
export const StopSchema = z.object({
  id: z.string(),
  day: z.number().int().min(1),
  title: z.string(),
  start: LocalDateTime,
  end: LocalDateTime,
  place: PlaceSchema,
  category: z.enum(['food', 'sight', 'activity', 'transit', 'lodging', 'free']).default('sight'),
  locked: z.boolean().default(false), // anchors
  priceRange: z.string().optional(),  
  sourceUrl: z.string().url().optional(),
  notes: z.string().optional(),
});

//saved travel preferences of user in profile
export const PreferencesSchema = z.object({
  budgetPerDay: z.number().optional(),
  activeHours: z.object({ start: z.string(), end: z.string() }).optional(), 
  interests: z.array(z.string()).default([]),
  dietary: z.array(z.string()).default([]),
  activityLevel: z.enum(['low', 'medium', 'high']).optional(),
  pace: z.enum(['relaxed', 'balanced', 'packed']).optional(),
});

//entire trip layout
export const TripSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  memberIds: z.array(z.string()).default([]),
  startDate: z.string(),              // "2026-11-20"
  endDate: z.string(),
  status: z.enum(['gathering', 'ready', 'planned']).default('gathering'),
  details: z.record(z.string(), z.any()).default({}),
  anchors: z.array(z.string()).default([]),
  overrides: PreferencesSchema.partial().default({}),
  stops: z.array(StopSchema).default([]),
});

//follow-up question layout from LLM
export const QuestionSchema = z.object({
  id: z.string(),
  field: z.string(),
  type: z.enum(['single_choice', 'multi_choice', 'text', 'date_range', 'number_range']),
  prompt: z.string(),
  options: z.array(z.string()).optional(),
});

//Preferences trade-off layout for comparison between options
export const ComparisonOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  cost: z.string(),
  travelTime: z.string(),
  location: z.string(),
  suits: z.array(z.string()),          //names of members this option fits perfectly
  sourceUrl: z.string().url().optional(),
});

export const ComparisonSchema = z.object({
  id: z.string(),
  prompt: z.string(), //decision being asked
  options: z.tuple([ComparisonOptionSchema, ComparisonOptionSchema]), //pairwise
});

//LLM response to answers from POST /api/chat
export const ChatResponseSchema = z.object({
  status: z.enum(['gathering', 'ready']),
  reply: z.string(),
  question: QuestionSchema.nullish(),
  extracted: z.record(z.string(), z.any()).default({}),
  comparison: ComparisonSchema.nullish(),
  itinerary: z.array(StopSchema).nullish(),
});

//changes to calendar in the view
export const EditDiffSchema = z.object({
  stopId: z.string(),
  from: z.object({ start: LocalDateTime, end: LocalDateTime }),
  to: z.object({ start: LocalDateTime, end: LocalDateTime }),
});

//POST /api/itinerary/change return
export const ChangeResponseSchema = z.object({
  summary: z.string(),
  changes: z.array(StopSchema),        // full updated stops
  warnings: z.array(z.string()).default([]),
});

//generated types from schema
export type Place = z.infer<typeof PlaceSchema>;
export type Stop = z.infer<typeof StopSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type Trip = z.infer<typeof TripSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Comparison = z.infer<typeof ComparisonSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type EditDiff = z.infer<typeof EditDiffSchema>;
export type ChangeResponse = z.infer<typeof ChangeResponseSchema>;

//a singular chat bubble in the application
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  question?: Question | null;
  comparison?: Comparison | null;
  createdAt: number;
}

//Evaluated and combined group preferences
export interface GroupPreferences {
  members: { uid: string; name: string; preferences: Preferences }[];
  merged: Preferences;
  conflicts: { field: string; message: string }[];
}