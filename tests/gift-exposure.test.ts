import { describe, expect, it } from 'vitest';
import { AdminConfigService } from '../src/admin/AdminConfigService.js';
import { SemanticGameService } from '../src/game/SemanticGameService.js';
import { SemanticGameGateway, type SemanticGameMessage } from '../src/game/SemanticGameGateway.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Normalizer } from '../src/core/Normalizer.js';
import type { NormalizedLiveEvent } from '../src/core/events.js';

describe('immediate gift exposure', () => {
  it('transports normalized gift identity through the real WebSocket gateway', async () => {
    const http = createServer();
    const gateway = new SemanticGameGateway({ info() {}, warn() {} }, () => ({ type: 'ROOM_SNAPSHOT' }));
    gateway.attach(http);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/word-game`);
    try {
      const [snapshot] = await once(socket, 'message');
      expect(JSON.parse(snapshot.toString()).type).toBe('ROOM_SNAPSHOT');
      const service = new SemanticGameService(gateway, new AdminConfigService('unused-gift-transport-test'));
      (service as unknown as { eventQueue: Promise<void> }).eventQueue = new Promise(() => {});
      const event = new Normalizer().normalize({ type: 'gift', data: {
        giftId: 5655, giftName: 'Rose', giftIcon: 'https://example.com/gift.webp', giftType: 0, count: 3, diamondCount: 1,
        user: { id: 'real-shape-42', uniqueId: 'sender42', nickname: '传输测试', avatarThumb: { urlList: ['https://example.com/avatar.webp'] } }
      } }, 'tiktok', 'isolated-test', 1);
      const received = once(socket, 'message');
      service.handleEvent(event);
      const [data] = await received;
      expect(JSON.parse(data.toString())).toMatchObject({ type: 'GIFT_RECEIVED', eventId: event.eventId,
        actor: { id: 'real-shape-42', nickname: '传输测试', avatarUrl: 'https://example.com/avatar.webp' },
        gift: { name: 'Rose', icon: 'https://example.com/gift.webp', count: 3, diamondCount: 1, totalValue: 3 } });
    } finally {
      const closed = once(socket, 'close'); socket.close(); await closed;
      gateway.close(); await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });
  it('publishes the real sender and full gift value before a blocked calculation queue', () => {
    const messages: SemanticGameMessage[] = [];
    const service = new SemanticGameService({ broadcast: (m: SemanticGameMessage) => messages.push(m) } as unknown as SemanticGameGateway, new AdminConfigService('unused-gift-test'));
    (service as unknown as { eventQueue: Promise<void> }).eventQueue = new Promise(() => {});
    const event: NormalizedLiveEvent = { schemaVersion: 1, eventId: 'gift-a', sessionId: 's', sequence: 1, source: 'tiktok', receivedAt: 123, type: 'gift', user: { id: 'u', nickname: '阿白', avatarUrl: 'https://example.com/avatar.png' }, payload: { giftId: 'g', giftName: '彩带', giftIcon: 'https://example.com/gift.webp', count: 3, diamondCount: 200 } };
    service.handleEvent(event);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'GIFT_RECEIVED', eventId: 'gift-a', actor: event.user, gift: { id: 'g', name: '彩带', icon: 'https://example.com/gift.webp', count: 3, diamondCount: 200, totalValue: 600 } });
    service.handleEvent({ ...event, type: 'gift_progress' });
    expect(messages).toHaveLength(1);
  });
});
