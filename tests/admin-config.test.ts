import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminConfigService } from "../src/admin/AdminConfigService.js";

describe("AdminConfigService", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("provides safe defaults without exposing secrets", async () => {
    directory = await mkdtemp(join(tmpdir(), "semantic-admin-"));
    const service = new AdminConfigService(directory);
    service.loadSync();
    const view = service.view();
    expect(view.config.game.giftWordsMultiplier).toBe(10);
    expect(view.config.llm.batchSize).toBeLessThanOrEqual(100);
    expect(view.secrets).not.toHaveProperty("apiKey");
  });

  it("persists partial updates and reports restart effects", async () => {
    directory = await mkdtemp(join(tmpdir(), "semantic-admin-"));
    const service = new AdminConfigService(directory);
    service.loadSync();
    const updated = await service.update({ game: { likesPerHint: 2500 }, tiktok: { autoReconnect: false } });
    expect(updated.config.game.likesPerHint).toBe(2500);
    expect(updated.config.tiktok.autoReconnect).toBe(false);
    expect(updated.effects.requiresReconnect).toBe(true);

    const reloaded = new AdminConfigService(directory);
    reloaded.loadSync();
    expect(reloaded.current.game.likesPerHint).toBe(2500);
    expect(reloaded.current.tiktok.autoReconnect).toBe(false);
  });

  it("keeps concurrent partial updates and leaves live settings unchanged on disk failure", async () => {
    directory = await mkdtemp(join(tmpdir(), "semantic-admin-"));
    const service = new AdminConfigService(directory);
    await Promise.all([service.update({ game: { likesPerHint: 222 } }), service.update({ tiktok: { autoReconnect: false } })]);
    const reloaded = new AdminConfigService(directory); reloaded.loadSync();
    expect(reloaded.current).toMatchObject({ game: { likesPerHint: 222 }, tiktok: { autoReconnect: false } });
    const blocked = join(directory, "not-a-directory"); await writeFile(blocked, "test");
    const failing = new AdminConfigService(blocked); const before = failing.current;
    await expect(failing.update({ game: { likesPerHint: 999 } })).rejects.toThrow();
    expect(failing.current).toEqual(before);
  });
});
