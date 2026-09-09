export interface GiftComboInput {
  userId?: string;
  uniqueId?: string;
  giftId?: string;
  giftName?: string;
  count?: number;
  giftType?: number;
  repeatEnd?: boolean;
  diamondCount?: number;
}

export type GiftComboResult =
  | { kind: "progress"; count: number }
  | { kind: "settled"; count: number }
  | { kind: "ignored"; count: number };

/** Prevents cumulative processing of TikTok streak gift updates. */
export class GiftComboTracker {
  private readonly streaks = new Map<string, number>();

  process(input: GiftComboInput): GiftComboResult {
    const count = Number.isFinite(input.count) && (input.count ?? 0) > 0 ? Math.floor(input.count!) : 1;
    const isStreak = input.giftType === 1;
    const key = [input.userId ?? input.uniqueId ?? "unknown-user", input.giftId ?? input.giftName ?? "unknown-gift"].join(":");

    if (!isStreak) return { kind: "settled", count };

    if (input.repeatEnd === true) {
      this.streaks.delete(key);
      return { kind: "settled", count };
    }

    const previous = this.streaks.get(key) ?? 0;
    if (count <= previous) return { kind: "ignored", count };
    this.streaks.set(key, count);
    return { kind: "progress", count };
  }

  clear(): void {
    this.streaks.clear();
  }
}
