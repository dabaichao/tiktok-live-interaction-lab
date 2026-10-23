import { z } from "zod";

const action = z.object({
  type: z.enum(["random_words", "extra_time", "unlock_hint"]),
  amount: z.number().int().min(1).max(10000),
  basis: z.enum(["quantity", "value", "event"]),
  source: z.enum(["llm", "local"]).default("llm"),
}).strict();
export const interactionRuleSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().min(1).max(100), enabled: z.boolean(),
  trigger: z.enum(["gift", "like", "follow", "share"]),
  match: z.enum(["gift", "price", "default"]), giftId: z.string().max(100).default(""),
  minPrice: z.number().min(0).max(1e9).default(0), maxPrice: z.number().min(0).max(1e9).default(1e9),
  every: z.number().int().min(1).max(1000000).default(1),
  actions: z.array(action).max(3),
}).strict().superRefine((rule, ctx) => {
  if (rule.match === "gift" && (!rule.giftId || rule.trigger !== "gift")) ctx.addIssue({code:"custom",message:"指定礼物规则需要礼物 ID"});
  if (rule.match === "price" && (rule.trigger !== "gift" || rule.minPrice > rule.maxPrice)) ctx.addIssue({code:"custom",message:"价格范围无效"});
  if (rule.trigger !== "like" && rule.every !== 1) ctx.addIssue({code:"custom",message:"仅点赞支持累计次数阈值"});
  if (rule.trigger !== "gift" && rule.actions.some(a => a.basis === "value")) ctx.addIssue({code:"custom",message:"只有礼物可以按平台价值计算"});
  if (new Set(rule.actions.map(a => a.type)).size !== rule.actions.length) ctx.addIssue({code:"custom",message:"同一种效果不能重复配置"});
});
export const rulesSchema = z.array(interactionRuleSchema).max(500).superRefine((rules,ctx) => {
  if (new Set(rules.map(r=>r.id)).size !== rules.length) ctx.addIssue({code:"custom",message:"规则 ID 重复"});
  const keys = rules.filter(r=>r.enabled && r.match !== "price").map(r=>`${r.trigger}:${r.match}:${r.match === "gift" ? r.giftId : ""}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({code:"custom",message:"同一触发条件只能启用一条规则"});
});
export type InteractionRule = z.infer<typeof interactionRuleSchema>;
export interface InteractionInput { trigger: "gift" | "like" | "follow" | "share"; giftId?: string; unitPrice?: number; quantity: number; }
export interface InteractionPlan { ruleId?: string; ruleName: string; randomWords: number; extraTimeMs: number; hints: number; wordSource: "llm" | "local"; quantity: number; totalValue?: number; note: string; }
export function defaultRules(): InteractionRule[] {
  return rulesSchema.parse([
    {id:"like-default",name:"每个点赞随机 1 词",enabled:true,trigger:"like",match:"default",actions:[{type:"random_words",amount:1,basis:"quantity",source:"local"}]},
    {id:"gift-default",name:"礼物总价值 × 10 词",enabled:true,trigger:"gift",match:"default",actions:[{type:"random_words",amount:10,basis:"value",source:"llm"}]},
  ]);
}
export function matchRule(rules: InteractionRule[], input: InteractionInput): InteractionRule | undefined {
  const matching = rules.filter(r=>r.enabled && r.trigger === input.trigger);
  return matching.find(r=>r.match === "gift" && r.giftId === input.giftId)
    ?? matching.find(r=>r.match === "price" && input.unitPrice !== undefined && input.unitPrice >= r.minPrice && input.unitPrice <= r.maxPrice)
    ?? matching.find(r=>r.match === "default");
}
export function planInteraction(rule: InteractionRule | undefined, input: InteractionInput): InteractionPlan {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0 || (input.unitPrice !== undefined && (!Number.isFinite(input.unitPrice) || input.unitPrice < 0))) throw new Error("互动数量或礼物单价无效，未执行效果。");
  const quantity = Math.max(0, Math.floor(input.quantity));
  const totalValue = input.unitPrice === undefined ? undefined : input.unitPrice * quantity;
  const plan: InteractionPlan = {ruleId:rule?.id,ruleName:rule?.name ?? "未配置，仅记录",randomWords:0,extraTimeMs:0,hints:0,wordSource:"llm",quantity,totalValue,note:""};
  if (!rule || !quantity) return plan;
  for (const action of rule.actions) {
    if (action.basis === "value" && totalValue === undefined) { plan.note = "礼物价格未知，价值倍率效果未执行；可导入价格或配置固定数量。"; continue; }
    const amount = action.amount * (action.basis === "value" ? totalValue! : action.basis === "quantity" ? quantity : 1);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("计算数量超出安全范围，请调整规则。");
    if (action.type === "random_words") {plan.randomWords = amount; plan.wordSource = action.source;}
    if (action.type === "extra_time") {
      if (!Number.isSafeInteger(amount * 1000)) throw new Error("加时时长超出安全范围，请调整规则。");
      plan.extraTimeMs = amount * 1000;
    }
    if (action.type === "unlock_hint") plan.hints = amount;
  }
  return plan;
}
