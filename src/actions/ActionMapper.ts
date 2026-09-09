import { randomUUID } from "node:crypto";
import type { NormalizedLiveEvent } from "../core/events.js";
import type { GameAction } from "./GameAction.js";
import { RuleEngine, type GameRule } from "./RuleEngine.js";

export interface RulesConfig {
  rules: GameRule[];
}

export class ActionMapper {
  private readonly engine: RuleEngine;

  constructor(config: RulesConfig) {
    this.engine = new RuleEngine(config.rules ?? []);
  }

  map(event: NormalizedLiveEvent): GameAction[] {
    const actor = event.user
      ? {
          id: event.user.id,
          uniqueId: event.user.uniqueId,
          nickname: event.user.nickname,
          avatarUrl: event.user.avatarUrl,
        }
      : undefined;
    return this.engine.matchingRules(event).map((rule) => ({
      schemaVersion: 1 as const,
      actionId: randomUUID(),
      sourceEventId: event.eventId,
      timestamp: Date.now(),
      actor,
      action: rule.emit.action,
      power: rule.emit.power,
      args: actionArgs(rule.emit.args, event),
    }));
  }
}

function actionArgs(baseArgs: Record<string, unknown> | undefined, event: NormalizedLiveEvent): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = { ...(baseArgs ?? {}) };
  if (event.type === "gift") {
    if (event.payload.count !== undefined) args.count = event.payload.count;
    if (event.payload.giftId !== undefined) args.giftId = event.payload.giftId;
    if (event.payload.giftName !== undefined) args.giftName = event.payload.giftName;
  }
  if (event.type === "like" && event.payload.count !== undefined) args.count = event.payload.count;
  if (event.type === "room_stats") {
    if (event.payload.viewerCount !== undefined) args.viewerCount = event.payload.viewerCount;
    if (event.payload.totalLikes !== undefined) args.totalLikes = event.payload.totalLikes;
  }
  return Object.keys(args).length > 0 ? args : undefined;
}
