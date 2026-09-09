import type { NormalizedLiveEvent } from "../core/events.js";

export interface RuleWhen {
  type?: string;
  commandText?: string;
  giftId?: string;
  giftName?: string;
}

export interface RuleEmit {
  action: string;
  power?: number;
  args?: Record<string, unknown>;
}

export interface GameRule {
  when: RuleWhen;
  emit: RuleEmit;
}

export class RuleEngine {
  constructor(private readonly rules: GameRule[]) {}

  matches(rule: GameRule, event: NormalizedLiveEvent): boolean {
    if (rule.when.type && rule.when.type !== event.type) return false;
    if (event.type === "gift_progress") return false;
    const commandText = typeof event.payload.commandText === "string" ? event.payload.commandText : undefined;
    const giftId = event.payload.giftId === undefined ? undefined : String(event.payload.giftId);
    const giftName = event.payload.giftName === undefined ? undefined : String(event.payload.giftName);
    if (rule.when.commandText && rule.when.commandText.toLowerCase() !== commandText?.toLowerCase()) return false;
    if (rule.when.giftId && rule.when.giftId !== giftId) return false;
    if (rule.when.giftName && rule.when.giftName.toLowerCase() !== giftName?.toLowerCase()) return false;
    return true;
  }

  matchingRules(event: NormalizedLiveEvent): GameRule[] {
    return this.rules.filter((rule) => this.matches(rule, event));
  }
}
