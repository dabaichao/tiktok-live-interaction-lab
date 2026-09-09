import { z } from "zod";

export interface GameAction {
  schemaVersion: 1;
  actionId: string;
  sourceEventId: string;
  timestamp: number;
  actor?: {
    id?: string;
    uniqueId?: string;
    nickname?: string;
    avatarUrl?: string;
  };
  action: string;
  power?: number;
  args?: Record<string, unknown>;
}

export const gameActionSchema = z.object({
  schemaVersion: z.literal(1),
  actionId: z.string().min(1),
  sourceEventId: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  actor: z
    .object({
      id: z.string().optional(),
      uniqueId: z.string().optional(),
      nickname: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .optional(),
  action: z.string().min(1),
  power: z.number().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});
