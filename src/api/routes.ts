import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { ReplaySpeed } from "../sources/ReplaySource.js";
import type { SimulatorMessage } from "../sources/SimulatorSource.js";

export interface LabController {
  status(): unknown;
  dictionaryStatus(): unknown;
  resolveDictionaryWord(text: string, language?: string): unknown;
  connect(username: string): Promise<unknown>;
  disconnect(): Promise<unknown>;
  startRecording(): Promise<unknown>;
  stopRecording(): Promise<unknown>;
  listSessions(): Promise<unknown>;
  startReplay(sessionId: string, speed: ReplaySpeed): Promise<unknown>;
  pauseReplay(): unknown;
  resumeReplay(): unknown;
  stopReplay(): unknown;
  restartReplay(): unknown;
  simulate(message: SimulatorMessage): unknown;
}

const connectSchema = z.object({ username: z.string().trim().min(1).max(100) });
const emptyBodySchema = z.object({}).passthrough();
const replaySchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  speed: z.union([z.literal(0.25), z.literal(0.5), z.literal(1), z.literal(2), z.literal(5), z.literal(10), z.literal("MAX")]).default(1),
});
const simulateSchema = z.object({
  type: z.enum(["chat", "like", "gift", "join", "follow", "share"]),
  user: z
    .object({
      id: z.string().optional(),
      uniqueId: z.string().optional(),
      nickname: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .optional(),
  text: z.string().max(500).optional(),
  comment: z.string().max(500).optional(),
  giftId: z.union([z.string(), z.number()]).optional(),
  giftName: z.string().max(100).optional(),
  count: z.number().int().positive().optional(),
  giftType: z.number().int().optional(),
  repeatEnd: z.boolean().optional(),
  diamondCount: z.number().nonnegative().optional(),
  totalLikes: z.number().nonnegative().optional(),
});

export function createApiRouter(controller: LabController): Router {
  const router = Router();

  router.get("/status", (_req, res) => res.json({ ok: true, data: controller.status() }));
  router.get("/dictionary/status", (_req, res) => res.json({ ok: true, data: controller.dictionaryStatus() }));
  router.get("/dictionary/resolve", (req, res) => {
    const text = typeof req.query.text === "string" ? req.query.text.trim() : "";
    if (!text) throw new ApiError("DICTIONARY_TEXT_REQUIRED", "Query parameter text is required");
    const language = typeof req.query.language === "string" ? req.query.language : undefined;
    res.json({ ok: true, data: controller.resolveDictionaryWord(text, language) });
  });
  router.post("/connect", asyncHandler(async (req, res) => {
    const { username } = connectSchema.parse(req.body);
    res.json({ ok: true, data: await controller.connect(username) });
  }));
  router.post("/disconnect", asyncHandler(async (req, res) => {
    emptyBodySchema.parse(req.body);
    res.json({ ok: true, data: await controller.disconnect() });
  }));
  router.post("/recording/start", asyncHandler(async (req, res) => {
    emptyBodySchema.parse(req.body);
    res.json({ ok: true, data: await controller.startRecording() });
  }));
  router.post("/recording/stop", asyncHandler(async (req, res) => {
    emptyBodySchema.parse(req.body);
    res.json({ ok: true, data: await controller.stopRecording() });
  }));
  router.get("/sessions", asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await controller.listSessions() });
  }));
  router.post("/replay/start", asyncHandler(async (req, res) => {
    const input = replaySchema.parse(req.body);
    res.json({ ok: true, data: await controller.startReplay(input.sessionId, input.speed) });
  }));
  router.post("/replay/pause", (req, res) => { emptyBodySchema.parse(req.body); res.json({ ok: true, data: controller.pauseReplay() }); });
  router.post("/replay/resume", (req, res) => { emptyBodySchema.parse(req.body); res.json({ ok: true, data: controller.resumeReplay() }); });
  router.post("/replay/stop", (req, res) => { emptyBodySchema.parse(req.body); res.json({ ok: true, data: controller.stopReplay() }); });
  router.post("/replay/restart", (req, res) => { emptyBodySchema.parse(req.body); res.json({ ok: true, data: controller.restartReplay() }); });
  router.post("/simulate", asyncHandler(async (req, res) => {
    const input = simulateSchema.parse(req.body) as SimulatorMessage;
    res.json({ ok: true, data: controller.simulate(input) });
  }));

  return router;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({ ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: { code: "VALIDATION_ERROR", message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") } });
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message } });
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}
