import { DyCast as CoreDyCast, decodeLikeMessage, decodeGiftMessage, decodeSocialMessage } from "@dycast/core";
export * from "@dycast/core";

const supported = new Set(["WebcastChatMessage", "WebcastGiftMessage", "WebcastLikeMessage", "WebcastChatLikeMessage", "WebcastMemberMessage", "WebcastSocialMessage", "WebcastEmojiChatMessage", "WebcastRoomUserSeqMessage", "WebcastControlMessage", "WebcastRoomRankMessage", "WebcastRoomStatsMessage"]);
const numeric = value => { const n = Number(value?.toString?.() ?? value); return Number.isFinite(n) && n >= 0 ? n : undefined; };
const unusableUserIds = new Set(['', '0', '-1', '111111', 'null', 'undefined']);
const cleanUserId = value => {
  const id = String(value?.toString?.() ?? value ?? '').trim();
  return unusableUserIds.has(id.toLowerCase()) || /[*＊]/u.test(id) ? '' : id;
};
const maskedNickname = value => /[*＊]{2,}/u.test(String(value ?? ''));
function increment(counts, method) {
  const key = /^Webcast[A-Za-z0-9_]{1,80}$/.test(method || '') ? method : 'other';
  const safeKey = key in counts || Object.keys(counts).length < 64 ? key : 'other';
  counts[safeKey] = (counts[safeKey] || 0) + 1;
  return safeKey;
}

/** Local adapter: keep upstream implementation intact while exposing decode failures. */
export class DyCast extends CoreDyCast {
  constructor(room) {
    super(room);
    this.diagnostics = { frames: 0, frameErrors: 0, rawMethods: {}, decodedMethods: {}, droppedMethods: {}, decodeErrors: {}, decodeFailureReasons: {}, lastFrameAt: 0 };
  }
  getDiagnostics() { return structuredClone(this.diagnostics); }
  async _decodeFrame(data) {
    this.diagnostics.frames += 1;
    this.diagnostics.lastFrameAt = Date.now();
    try {
      const result = await super._decodeFrame(data);
      for (const message of result?.response?.messages || []) increment(this.diagnostics.rawMethods, message.method);
      return result;
    } catch (error) { this.diagnostics.frameErrors += 1; throw error; }
  }
  async _dealMessage(message) {
    let result;
    // Only fixed stage labels and counts are retained. Never store exceptions,
    // payloads, message/user IDs, nicknames, or model answers in diagnostics.
    let failureReason = 'upstream_decoder_failed';
    try {
      if (message.method === 'WebcastLikeMessage' || message.method === 'WebcastChatLikeMessage') {
        // Both methods have count=2, total=3, User=5 in the community protocol.
        // Reference: adseng/dy-comment-cast/proto/douyin.proto (ChatLikeMessage).
        failureReason = 'like_payload_decode_failed';
        const decoded = decodeLikeMessage(message.payload);
        failureReason = 'like_count_invalid';
        const count = numeric(decoded.count);
        if (count === undefined) throw new Error('invalid_like_count');
        if (count === 0) { failureReason = 'like_count_zero'; throw new Error('invalid_like_count'); }
        failureReason = 'like_user_mapping_failed';
        const user = this._getCastUser(decoded.user);
        failureReason = 'like_event_mapping_failed';
        result = { id: String(message.msgId || ''), method: message.method, user, count, content: `为主播点赞了(${count})`, room: { likeCount: numeric(decoded.total) } };
      } else {
        result = await super._dealMessage(message);
        if (!result) failureReason = 'upstream_decoder_returned_empty';
        if(result && message.method==='WebcastGiftMessage') {
          failureReason = 'gift_postprocess_failed';
          const decoded=decodeGiftMessage(message.payload);
          if(result.gift) result.gift.groupId=String(decoded.groupId||'');
        }
        if(result && message.method==='WebcastSocialMessage') {
          failureReason = 'social_postprocess_failed';
          // Preserve protocol action: the upstream library labels ALL social
          // messages as follows, which must not trigger the wrong game rule.
          const decoded=decodeSocialMessage(message.payload);
          result.socialAction=String(decoded.action??'');
          result.content=result.socialAction==='1'?'关注了主播':result.socialAction==='3'?'分享了直播间':'直播间社交互动';
        }
      }
    } catch { result = null; }
    if (result) increment(this.diagnostics.decodedMethods, message.method);
    else if (supported.has(message.method)) {
      const method = increment(this.diagnostics.decodeErrors, message.method);
      const reasons = this.diagnostics.decodeFailureReasons[method] ||= {};
      reasons[failureReason] = (reasons[failureReason] || 0) + 1;
    } else increment(this.diagnostics.droppedMethods, message.method);
    return result;
  }
  _getCastUser(user) {
    const result = super._getCastUser(user);
    if (result) {
      // The anonymous Webcast payload currently uses 111111 for many unrelated
      // viewers. Never pass that placeholder downstream as a real account ID.
      // Prefer another stable protocol field when it is actually present.
      // Newer Douyin payloads may keep account fields private while still
      // exposing a per-viewer webcastUid. It is suitable for grouping live
      // events even though it is not a public profile identifier.
      const candidates = [user.secUid, user.webcastUid, user.id, user.displayId, user.shortId, user.specialId];
      result.id = candidates.map(cleanUserId).find(Boolean) || '';
      result.displayId = cleanUserId(user.displayId);
      result.shortId = cleanUserId(user.shortId);
      result.nicknameMasked = maskedNickname(result.name);
      result.identityLimited = !result.id || user.isAnonymous === true;
    }
    return result;
  }
}
