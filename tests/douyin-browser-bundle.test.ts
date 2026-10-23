import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWebcastBrowserBundle } from "../src/douyin/WebcastBrowserBundle.js";

describe("Douyin browser bundle", () => {
  it("loads without an npm resolver and decodes a gzipped Webcast frame", async () => {
    const code = await buildWebcastBrowserBundle(resolve("."));
    // A data URL has no node_modules resolution. The previous bare pako import
    // fails here just as it does in a browser. Use a subprocess to avoid Vitest's
    // own module transforms and provide only the globals read during loading.
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { gzipSync } from 'node:zlib';
      import assert from 'node:assert/strict';
      globalThis.location = { origin: 'http://127.0.0.1:3002' };
      Object.defineProperty(globalThis, 'navigator', { value: {
        userAgent: 'Mozilla/5.0', appVersion: '5.0', appCodeName: 'Mozilla'
      }, configurable: true });
      const module = await import('data:text/javascript;base64,' + readFileSync(0).toString('base64'));
      const client = new module.DyCast('123456789');
      assert.equal(typeof client.connect, 'function');
      // Protobuf Response.cursor (field 2) = "ok", compressed with real gzip.
      const payload = gzipSync(Uint8Array.of(18, 2, 111, 107));
      const frame = module.encodePushFrame({
        headersList: { compress_type: 'gzip' }, payloadType: 'msg', payload
      });
      const decoded = await client._decodeFrame(frame);
      assert.equal(decoded.cursor, 'ok');
      assert.equal(decoded.response.cursor, 'ok');
      const like = await client._dealMessage({ method:'WebcastChatLikeMessage', msgId:'alternate', payload:Uint8Array.of(16,3,24,99) });
      assert.equal(like.method, 'WebcastChatLikeMessage');
      assert.equal(like.count, 3);
      assert.equal(like.room.likeCount, 99);
      const normal = await client._dealMessage({ method:'WebcastLikeMessage', msgId:'normal', payload:Uint8Array.of(16,2,24,101) });
      assert.equal(normal.count, 2);
      const social = await client._dealMessage({method:'WebcastSocialMessage',msgId:'share',payload:Uint8Array.of(32,3)});
      assert.equal(social.socialAction,'3');
      assert.equal(social.content,'分享了直播间');
      assert.equal(await client._dealMessage({method:'WebcastLikeMessage',payload:new Uint8Array()}), null);
      assert.equal(await client._dealMessage({method:'WebcastUnmappedMessage',payload:new Uint8Array()}), null);
      assert.equal(client._getCastUser({id:'123',nickname:'test'}).id, '123');
      assert.equal(client._getCastUser({secUid:'sec-123',id:'123',nickname:'test'}).id, 'sec-123');
      const displayFallback = client._getCastUser({secUid:'111111',id:'111111',displayId:'real-display',nickname:'用***'});
      assert.equal(displayFallback.id, 'real-display');
      assert.equal(displayFallback.nicknameMasked, true);
      assert.equal(displayFallback.identityLimited, false);
      assert.equal(client._getCastUser({secUid:'111111',id:'111111',webcastUid:'webcast-viewer-9',nickname:'用***'}).id, 'webcast-viewer-9');
      const limited = client._getCastUser({secUid:'111111',id:'111111',displayId:'用***',shortId:'111111',nickname:'用***'});
      assert.equal(limited.id, '');
      assert.equal(limited.identityLimited, true);
      const metrics=client.getDiagnostics();
      assert.equal(metrics.decodedMethods.WebcastChatLikeMessage, 1);
      assert.equal(metrics.decodeErrors.WebcastLikeMessage, 1);
      assert.equal(metrics.droppedMethods.WebcastUnmappedMessage, 1);
      assert.ok(!JSON.stringify(metrics).includes('nickname'));
      // Synthetic payloads verify new privacy-safe stage counters. They are not
      // the three real failed payloads and do not prove a decoder repair.
      const failureClient = new module.DyCast('123456789');
      assert.equal(await failureClient._dealMessage({method:'WebcastChatLikeMessage',payload:Uint8Array.of(16,0,24,99)}),null);
      assert.equal(await failureClient._dealMessage({method:'WebcastChatLikeMessage',payload:Uint8Array.of(16,128)}),null);
      assert.equal(failureClient.getDiagnostics().decodeErrors.WebcastChatLikeMessage,2);
      assert.deepEqual(failureClient.getDiagnostics().decodeFailureReasons.WebcastChatLikeMessage,{
        like_count_zero:1,like_payload_decode_failed:1,
      });
      assert.equal(failureClient.getDiagnostics().frameErrors,0);
      assert.equal(failureClient.getDiagnostics().decodedMethods.WebcastChatLikeMessage,undefined);
      class UserFailureClient extends module.DyCast {
        _getCastUser() { throw new Error('private-exception-user-cookie-content'); }
      }
      const userFailureClient = new UserFailureClient('123456789');
      assert.equal(await userFailureClient._dealMessage({method:'WebcastChatLikeMessage',payload:Uint8Array.of(16,1)}),null);
      assert.deepEqual(userFailureClient.getDiagnostics().decodeFailureReasons.WebcastChatLikeMessage,{like_user_mapping_failed:1});
      const mappingFailureClient = new module.DyCast('123456789');
      assert.equal(await mappingFailureClient._dealMessage({method:'WebcastChatLikeMessage',payload:Uint8Array.of(16,1),msgId:{toString(){throw new Error('private-event-id');}}}),null);
      assert.deepEqual(mappingFailureClient.getDiagnostics().decodeFailureReasons.WebcastChatLikeMessage,{like_event_mapping_failed:1});
      assert.equal(await failureClient._dealMessage({method:'WebcastChatMessage',payload:Uint8Array.of(18,128)}),null);
      assert.deepEqual(failureClient.getDiagnostics().decodeFailureReasons.WebcastChatMessage,{upstream_decoder_returned_empty:1});
      assert.equal(await failureClient._dealMessage({method:'WebcastUnmappedMessage',payload:Uint8Array.of(16,128)}),null);
      assert.equal(failureClient.getDiagnostics().decodeFailureReasons.WebcastUnmappedMessage,undefined);
      assert.ok(!JSON.stringify([failureClient.getDiagnostics(),userFailureClient.getDiagnostics(),mappingFailureClient.getDiagnostics()]).includes('private-'));
      const clone=failureClient.getDiagnostics();
      clone.decodeFailureReasons.WebcastChatLikeMessage.like_count_zero=99;
      assert.equal(failureClient.getDiagnostics().decodeFailureReasons.WebcastChatLikeMessage.like_count_zero,1);
      const field = (tag, bytes) => Uint8Array.of(tag, bytes.length, ...bytes);
      const method = new TextEncoder().encode('WebcastChatLikeMessage');
      const message = Uint8Array.of(...field(10,method), ...field(18,Uint8Array.of(16,5,24,105)), 24,1);
      const response = field(10,message);
      const fullFrame = module.encodePushFrame({headersList:{compress_type:'gzip'},payloadType:'msg',payload:gzipSync(response)});
      const decodedFrame = await client._decodeFrame(fullFrame);
      const mapped = await client._dealMessage(decodedFrame.response.messages[0]);
      assert.equal(mapped.count,5);
      assert.equal(client.getDiagnostics().rawMethods.WebcastChatLikeMessage,1);
      process.stdout.write('browser-esm-and-gzip-ok');
    `], { input: code, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
    expect(output).toContain("browser-esm-and-gzip-ok");
  }, 30000);
});
