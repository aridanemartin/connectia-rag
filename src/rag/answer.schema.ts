import { z } from "zod";

export const answerDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    answer: z.string().min(1),
    citedChunkIds: z.array(z.string()).min(1),
  }),
  z.object({
    status: z.literal("not_found"),
    answer: z.null(),
    citedChunkIds: z.array(z.string()).length(0),
  }),
  z.object({
    status: z.literal("ambiguous"),
    answer: z.null(),
    citedChunkIds: z.array(z.string()).length(0),
  }),
]);

export type AnswerDecision = z.infer<typeof answerDecisionSchema>;
