const node = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {gift:'礼物',like:'点赞',follow:'关注',share:'分享'};
const eventLabels = {chat:'评论',gift:'礼物',gift_progress:'礼物连击中',like:'点赞',join:'进房',follow:'关注',share:'分享',social:'社交互动',room_stats:'房间统计',stream_end:'直播结束',unknown:'未知消息'};
const sourceLabels = {platform:'平台目录',observed:'直播实收',imported:'手动导入'};
const statusLabels = {queued:'排队中',running:'执行中',completed:'已完成',partial:'部分完成',cancelled:'已取消',failed:'失败','display-only':'仅记录'};
let data, editingId, ruleDraftBase, gameRevision, loadedGame = false, gameDirty = false, refreshJob, eventRefreshJob, lastRoom = '', eventStreamReady = false;
const seenEventIds = new Set();
function notify(message, error=false) {node('opFeedback').textContent=message;node('opFeedback').className=`feedback ${error?'error':'success'}`;}
async function request(path, method='GET', body) {
  const response=await fetch(`/api/douyin/operations${path}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(value.message||value.error||'操作失败，请重试。');
  return value;
}
async function task(button, action) {
  if(button?.disabled)return;
  if(button)button.disabled=true;
  try{if(!data)throw new Error('后台配置尚未读取完成，请稍后再试。');await action();}catch(error){notify(error.name==='TimeoutError'?'请求超时，请重新读取状态后再试。':error.message,true);}
  finally{if(button)button.disabled=false;}
}
function selectTab(tab) {
  for(const name of ['connection','events','catalog','rules','game','records']) node(`ops-${name}`).classList.toggle('hidden',name!==tab);
  document.querySelectorAll('[data-ops-tab]').forEach(button=>{const active=button.dataset.opsTab===tab;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
}
document.querySelectorAll('[data-ops-tab]').forEach(button=>button.addEventListener('click',()=>{selectTab(button.dataset.opsTab);void refresh();}));
function effects(rule) {
  if(!rule.actions.length)return '仅展示 / 记录，不产生游戏效果';
  return rule.actions.map(a=>`${a.type==='random_words'?'随机词':a.type==='extra_time'?'加时':'解锁提示'} ${a.amount}${a.type==='extra_time'?' 秒':a.type==='unlock_hint'?' 条':' 词'}${a.basis==='value'?' × 平台总价值':a.basis==='quantity'?' × 有效数量':' / 整笔事件'}${a.type==='random_words'?`（${a.source==='llm'?'AI':'本地词库'}）`:''}`).join('；');
}
function matchingLabel(rule) {
  return rule.match==='gift'?`礼物 ID ${rule.giftId}`:rule.match==='price'?`单价 ${rule.minPrice}～${rule.maxPrice}`:`${labels[rule.trigger]}默认${rule.trigger==='like'?` · 每累计 ${rule.every} 次`:''}`;
}
function renderRules() {
  node('opRuleList').innerHTML=data.rules.length?data.rules.map(rule=>`<article class="rule-row ${rule.enabled?'':'disabled'}"><div><strong>${escape(rule.name)}</strong><p>${escape(matchingLabel(rule))} · ${rule.enabled?'已启用':'已停用'}<br>${escape(effects(rule))}</p></div><div class="actions"><button data-rule-edit="${escape(rule.id)}">编辑</button><button data-rule-toggle="${escape(rule.id)}">${rule.enabled?'停用':'启用'}</button><button class="danger" data-rule-delete="${escape(rule.id)}">删除</button></div></article>`).join(''):'<div class="empty-ops">暂无规则。互动仍会记录，但不会产生游戏效果。</div>';
}
function giftOptions(id) {
  const value=node(id).value;
  node(id).innerHTML='<option value="">从目录选择，也可手动填写 ID</option>'+data.catalog.gifts.map(g=>`<option value="${escape(g.id)}">${escape(g.name)} · ${g.price??'未知价格'}</option>`).join('');
  node(id).value=value;
}
function renderCatalog() {
  const all=data.catalog.gifts;
  const query=node('opGiftSearch').value.trim().toLowerCase(),source=node('opGiftSource').value,configured=node('opGiftConfigured').value;
  let gifts=all.filter(g=>(!query||`${g.id} ${g.name}`.toLowerCase().includes(query))&&(!source||g.source===source));
  const specific=g=>data.rules.some(r=>r.trigger==='gift'&&r.match==='gift'&&r.giftId===g.id&&r.enabled);
  if(configured)gifts=gifts.filter(g=>specific(g)===(configured==='yes'));
  if(node('opGiftSort').value!=='name')gifts.sort((a,b)=>a.price===undefined?b.price===undefined?0:1:b.price===undefined?-1:(a.price-b.price)*(node('opGiftSort').value==='asc'?1:-1));
  node('opCatalogMeta').textContent=`已收录 ${all.length} 种 · 当前筛选 ${gifts.length} 种 · ${data.catalog.syncedAt?'上次平台同步 '+new Date(data.catalog.syncedAt).toLocaleString():'尚无平台同步'}。${data.catalog.message}`;
  node('opGiftGrid').innerHTML=gifts.length?gifts.map(g=>`<article class="gift-item">${/^https:\/\//.test(g.icon)?`<img src="${escape(g.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`:'<div class="gift-placeholder">✧</div>'}<div><strong>${escape(g.name)}</strong><small>ID ${escape(g.id)}</small><small>单价 ${g.price??'未知'} · ${sourceLabels[g.source]||'未知来源'}</small><small>${specific(g)?'已配置专属规则':'使用默认规则 / 未单独配置'}</small></div><button data-gift-configure="${escape(g.id)}">配置这个礼物</button></article>`).join(''):'<div class="empty-ops">暂无匹配礼物。连接直播间后同步平台目录；真实收到的礼物也会自动收录，或使用下方导入。</div>';
}
function renderRecords() {
  const all=data.records||[],showDisplay=node('opShowDisplayOnly').checked;
  const records=showDisplay?all:all.filter(r=>r.status!=='display-only');
  const hidden=all.length-records.length;
  node('opRecordMeta').textContent=hidden?`已隐藏 ${hidden} 条历史“仅记录、无效果”项目；它们没有改变游戏。`:'当前没有被隐藏的无效果项目。';
  const q=data.interactions;
  if(q)node('opRecordMeta').textContent+=` 当前排队 ${q.queuedJobs} 笔 · 执行 ${q.runningJobs} 笔 · 等待下一局 ${q.waitingForRound} 笔 · 剩余 ${q.remainingWords} 词 · 最久排队 ${Math.floor(q.oldestQueuedMs/1000)} 秒。`;
  node('opRecords').innerHTML=records.length?records.map(r=>`<tr><td>${new Date(r.createdAt).toLocaleTimeString()}<small>${escape(r.actor)}</small></td><td>${escape(r.giftName||labels[r.trigger]||r.trigger)} × ${r.plan.quantity}<small>${escape(r.plan.ruleName)} · 配置 v${r.ruleRevision}</small></td><td>${r.completedWords} / ${r.plan.randomWords}<small>AI ${r.aiWords??0} · 本地 ${r.localWords??0}${r.remainingWords===undefined?'':` · 剩余 ${r.remainingWords}`}${r.carriedRounds?` · 已续 ${r.carriedRounds} 局`:''}</small></td><td>${r.appliedTimeMs/1000} 秒 / ${r.unlockedHints} 条</td><td>${r.waitingForRound?'等待下一局':statusLabels[r.status]||escape(r.status)}<small>${escape(r.message)}</small></td></tr>`).join(''):'<tr><td colspan="5" class="empty-ops">当前直播间还没有真正产生游戏效果的执行记录。评论、进房和未配置互动请到“实时事件流”查看。</td></tr>';
}
function eventGroup(type) {return ['gift','gift_progress'].includes(type)?'gift':['follow','share','social'].includes(type)?'social':type;}
function eventDetail(item) {
  if(item.type==='chat')return item.text||'（空评论）';
  if(item.type==='gift'||item.type==='gift_progress')return `${item.gift?.name||'未命名礼物'} × ${item.gift?.count||1}${item.gift?.unitPrice===undefined?'':` · 单价 ${item.gift.unitPrice}${item.gift.totalValue===undefined?'':` · 总价值 ${item.gift.totalValue}`}`}${item.gift?.progress?' · 连击尚未结算':''}`;
  if(item.type==='like')return `点赞 × ${item.count||1}`;
  if(item.type==='join')return '进入直播间';
  if(item.type==='follow')return '关注了主播';
  if(item.type==='share')return '分享了直播间';
  if(item.type==='social')return '收到平台社交互动（类型未明确）';
  if(item.type==='room_stats')return `在线 ${item.room?.viewerCount??'—'} · 总点赞 ${item.room?.totalLikes??'—'} · 累计观众 ${item.room?.totalUserCount??'—'}`;
  if(item.type==='stream_end')return item.text||'直播已结束';
  return '收到一条暂未识别的消息';
}
function renderEvents() {
  const stream=data.eventStream;
  if(!stream){
    node('opEventMeta').textContent='当前服务版本尚未提供实时事件流，请重启本机抖音服务后刷新。';
    node('opEventStream').innerHTML='<div class="event-empty">等待新版服务提供实时事件数据。</div>';
    return;
  }
  const counts=stream.counts||{};
  const metrics={evChatCount:counts.chat,evJoinCount:counts.join,evFollowCount:counts.follow,evShareCount:counts.share,evLikeCount:counts.like,evGiftCount:counts.gift};
  for(const [id,value] of Object.entries(metrics))node(id).textContent=Number(value||0).toLocaleString();
  const selected=node('opEventType').value,query=node('opEventSearch').value.trim().toLocaleLowerCase(),showStats=node('opShowRoomStats').checked;
  const all=stream.items||[];
  const items=all.filter(item=>{
    if(item.type==='room_stats'&&!showStats)return false;
    if(selected&&eventGroup(item.type)!==selected)return false;
    if(!query)return true;
    return `${item.actor?.nickname||''} ${item.actor?.uniqueId||''} ${item.text||''} ${item.gift?.name||''}`.toLocaleLowerCase().includes(query);
  });
  node('opEventMeta').textContent=`当前连接累计：评论 ${counts.chat||0}、进房 ${counts.join||0}、关注 ${counts.follow||0}、分享 ${counts.share||0}、点赞消息 ${counts.like||0}、礼物完成 ${counts.gift||0}；内存保留最近 ${stream.retained||0} 条，当前显示 ${items.length} 条。`;
  node('opEventStream').innerHTML=items.length?items.map(item=>{
    const group=eventGroup(item.type),fresh=eventStreamReady&&!seenEventIds.has(item.id),name=item.actor?.nickname||'观众';
    const avatar=item.actor?.avatarUrl?`<img class="event-avatar" src="${escape(item.actor.avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`:`<span class="event-avatar event-avatar-fallback">${escape(name.slice(0,1)||'观')}</span>`;
    const identifier=item.actor?.uniqueId||'';
    const readableIdentifier=identifier&&identifier!==name&&identifier.length<=40&&!/^MS4w\./i.test(identifier)&&!/^limited-/i.test(identifier);
    const account=readableIdentifier?`@${identifier}`:item.actor?.nicknameMasked?'平台返回了脱敏昵称':'';
    return `<article class="event-row ${item.type==='room_stats'?'room-stats':''} ${fresh?'fresh':''}" data-event-id="${escape(item.id)}">${avatar}<div class="event-actor"><strong>${escape(name)}</strong><small>${escape(account)}</small></div><div class="event-content"><span class="event-badge ${escape(group==='room_stats'?'stats':group)}">${escape(eventLabels[item.type]||item.type)}</span>${escape(eventDetail(item))}</div><time class="event-time">${new Date(item.receivedAt).toLocaleTimeString()}</time></article>`;
  }).join(''):'<div class="event-empty">当前筛选条件下没有事件。若直播网页正在滚动而此处长期为空，请查看“直播连接”中的接收与解码诊断。</div>';
  for(const item of all)seenEventIds.add(item.id);
  if(seenEventIds.size>600){const keep=new Set(all.map(item=>item.id));for(const id of seenEventIds)if(!keep.has(id))seenEventIds.delete(id);}
  eventStreamReady=true;
}
function fillGame() {
  const {game,llm}=data.config,p=data.presentation;
  const values={gLanguage:game.language,gAnswer:game.answer,gDuration:game.roundDurationMs/1000,gSettlement:game.settlementDurationMs/1000,gDirection:p.directionHint,gWinner:p.winnerPoints,gSecond:p.secondPoints,gThird:p.thirdPoints,gAssist:p.assistPoints,gApi:llm.baseUrl,gRouting:llm.routingMode,gPreferred:llm.preferredModel,gFallbacks:llm.fallbackModels.join(','),gFixed:llm.fixedModel,gTimeout:llm.timeoutMs,gBatch:llm.batchSize};
  for(const [id,value] of Object.entries(values))node(id).value=value;
  node('gDictionary').innerHTML=data.library.packages.map(p=>`<option value="${escape(p.packageId)}">${escape(p.wordlistId)} · ${p.packageType==='question-bank'?'题目库':'词库'}</option>`).join('');
  node('gDictionary').value=game.dictionaryPackageId;
  node('gTimedHints').checked=p.timedHints;node('gLocalFallback').checked=game.allowLocalGiftFallback;
  gameRevision=data.revision;
  loadedGame=true;gameDirty=false;
}
async function refresh(forceGame=false, fresh=false) {
  if(refreshJob){await refreshJob;if(!forceGame&&!fresh)return;}
  const job=(async()=>{
  try {
    data=await request('');
    renderRules();renderCatalog();renderRecords();renderEvents();
    giftOptions('rGiftSelect');giftOptions('sGiftSelect');
    const roomValue=node('opRecentRooms').value;
    node('opRecentRooms').innerHTML='<option value="">选择后填入，不会立即连接</option>'+data.rooms.map(r=>`<option value="${escape(r.webRid)}">${escape(r.title)} · ${escape(r.webRid)}</option>`).join('');
    node('opRecentRooms').value=roomValue;
    node('opRoomScope').textContent=data.roomKey==='unconnected'?'尚未选择直播间':`房间：${data.roomKey.replace(/^[^:]+:/,'')}`;
    node('opLibraryStats').textContent=`词库 ${data.library.wordlistCount} 个 · 题目库 ${data.library.questionBankCount} 个 · 待审核补词 ${data.library.supplementCount} 条`;
    node('opGameState').textContent=`游戏：${({RUNNING:'进行中',PAUSED:'已暂停',ANSWERED:'等待结算',SETTLEMENT:'结算中',WAITING:'等待开始'})[data.game.round?.status]||'待启动'} · 第 ${data.game.round?.roundNo??'—'} 局`;
    if(!loadedGame||forceGame||!gameDirty)fillGame();
    if(data.storageError)notify(data.storageError,true);
  } catch(error){notify(error.message,true);}
  })();
  refreshJob=job;
  try{await job;}finally{if(refreshJob===job)refreshJob=undefined;}
}
async function refreshEvents() {
  if(eventRefreshJob)return eventRefreshJob;
  eventRefreshJob=(async()=>{
    try {
      const stream=await request('/events');
      if(!data)data={eventStream:stream};else data.eventStream=stream;
      renderEvents();
    } catch(error){notify(error.message,true);}
  })();
  try{await eventRefreshJob;}finally{eventRefreshJob=undefined;}
}
function editRule(rule) {
  if(!data){notify('正在读取后台配置，请稍后再试。',true);return;}
  ruleDraftBase=structuredClone({rules:data.rules,revision:data.revision});
  editingId=rule?.id;
  const r=rule||{name:'',trigger:'gift',match:'gift',giftId:'',minPrice:0,maxPrice:1000000000,every:1,enabled:true,actions:[]};
  for(const [id,key] of Object.entries({rName:'name',rTrigger:'trigger',rMatch:'match',rGiftId:'giftId',rMin:'minPrice',rMax:'maxPrice',rEvery:'every'}))node(id).value=r[key];
  node('rEnabled').checked=r.enabled;node('rGiftSelect').value=r.giftId;
  for(const [prefix,type] of [['rWords','random_words'],['rTime','extra_time'],['rHint','unlock_hint']]){
    const a=r.actions.find(a=>a.type===type);node(prefix).checked=!!a;
    node(`${prefix}Amount`).value=a?.amount??(type==='extra_time'?30:type==='random_words'?10:1);
    node(`${prefix}Basis`).value=a?.basis??(type==='unlock_hint'?'event':'quantity');
    if(type==='random_words')node('rWordsSource').value=a?.source??'llm';
  }
  node('opRuleTitle').textContent=editingId?'编辑规则':'新增规则';
  node('opRuleForm').classList.remove('hidden');selectTab('rules');
}
function formRule() {
  const trigger=node('rTrigger').value;
  const match=trigger==='gift'?node('rMatch').value:'default';
  return {id:editingId||crypto.randomUUID(),name:node('rName').value.trim(),enabled:node('rEnabled').checked,trigger,match,giftId:match==='gift'?node('rGiftId').value.trim():'',minPrice:Number(node('rMin').value),maxPrice:Number(node('rMax').value),every:trigger==='like'?Number(node('rEvery').value):1,
    actions:[['rWords','random_words'],['rTime','extra_time'],['rHint','unlock_hint']].filter(([p])=>node(p).checked).map(([p,type])=>({type,amount:Number(node(`${p}Amount`).value),basis:node(`${p}Basis`).value,source:p==='rWords'?node('rWordsSource').value:'llm'}))};
}
async function saveRules(rules,revision=data.revision) {await request('/rules','PUT',{rules,revision});await refresh(false,true);notify('规则已保存，后续新互动立即生效；已排队任务按原规则完成。');}
node('opRuleForm').addEventListener('submit',event=>{event.preventDefault();void task(event.submitter,async()=>{
  const rule=formRule();await saveRules(editingId?ruleDraftBase.rules.map(r=>r.id===editingId?rule:r):[...ruleDraftBase.rules,rule],ruleDraftBase.revision);node('opRuleForm').classList.add('hidden');
});});
node('opRuleList').addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  const id=button.dataset.ruleEdit||button.dataset.ruleToggle||button.dataset.ruleDelete;
  const rule=data.rules.find(r=>r.id===id);if(!rule)return;
  if(button.dataset.ruleEdit){editRule(rule);return;}
  void task(button,async()=>{
    if(button.dataset.ruleDelete&&!confirm(`删除「${rule.name}」？此条件可能转为使用默认规则。`))return;
    await saveRules(button.dataset.ruleDelete?data.rules.filter(r=>r.id!==id):data.rules.map(r=>r.id===id?{...r,enabled:!r.enabled}:r));
  });
});
node('opGiftGrid').addEventListener('click',event=>{
  const button=event.target.closest('[data-gift-configure]');if(!button)return;
  const gift=data.catalog.gifts.find(g=>g.id===button.dataset.giftConfigure);if(!gift)return;
  const rule=data.rules.find(r=>r.trigger==='gift'&&r.match==='gift'&&r.giftId===gift.id);
  editRule(rule);if(!rule){node('rGiftId').value=gift.id;node('rGiftSelect').value=gift.id;node('rName').value=`${gift.name}专属效果`;}
});
node('opNewRule').addEventListener('click',()=>editRule());
node('opCancelRule').addEventListener('click',()=>node('opRuleForm').classList.add('hidden'));
node('rGiftSelect').addEventListener('change',()=>{node('rGiftId').value=node('rGiftSelect').value;});
node('rTrigger').addEventListener('change',()=>{if(node('rTrigger').value!=='gift')node('rMatch').value='default';});
for(const id of ['opGiftSearch','opGiftSource','opGiftConfigured','opGiftSort'])node(id).addEventListener('input',()=>{if(data)renderCatalog();});
node('opRecentRooms').addEventListener('change',()=>{if(node('opRecentRooms').value)node('webcastRoom').value=node('opRecentRooms').value;});
node('opReload').addEventListener('click',()=>{if(confirm('重新读取将丢弃未保存的规则和游戏设置，继续吗？')){node('opRuleForm').classList.add('hidden');void refresh(true);}});
node('opReloadGame').addEventListener('click',()=>{if(confirm('重新读取会覆盖尚未保存的游戏设置，继续吗？'))void refresh(true);});
for(const name of ['input','change'])node('opGameForm').addEventListener(name,()=>{gameDirty=true;});
node('opRefreshRecords').addEventListener('click',()=>void refresh());
node('opRefreshEvents').addEventListener('click',()=>void refreshEvents());
node('opShowDisplayOnly').addEventListener('change',()=>{if(data)renderRecords();});
for(const id of ['opEventType','opEventSearch','opShowRoomStats'])node(id).addEventListener('input',()=>{if(data)renderEvents();});
node('opResetRules').addEventListener('click',event=>void task(event.target,async()=>{
  if(!confirm('恢复默认会替换全部抖音互动规则：点赞随机 1 词，礼物总价值 × 10 词，不自动加时或解锁提示。'))return;
  await request('/rules/reset','POST',{revision:data.revision});await refresh(false,true);notify('已恢复默认规则。');
}));
node('opSyncCatalog').addEventListener('click',event=>void task(event.target,async()=>{
  notify('正在请求当前直播间的平台礼物目录……');await request('/catalog/sync','POST',{});await refresh(false,true);notify('平台目录已同步，具体可赠送资格仍以直播间页面为准。');
}));
async function readJsonFile(id) {
  const file=node(id).files?.[0];if(!file)throw new Error('请先选择 JSON 文件。');
  const maxBytes=id==='opDictionaryFile'?10000000:1500000;
  if(file.size>maxBytes)throw new Error(`文件不能超过 ${id==='opDictionaryFile'?'10 MB':'1.5 MB'}。`);
  const text=await file.text();try{return {file,text,parsed:JSON.parse(text)};}catch{throw new Error('文件不是有效 JSON，请检查格式。');}
}
node('opImportCatalog').addEventListener('click',event=>void task(event.target,async()=>{
  const {parsed}=await readJsonFile('opCatalogFile');await request('/catalog/import','POST',{gifts:Array.isArray(parsed)?parsed:parsed?.gifts});await refresh(false,true);notify('礼物已导入，来源标记为手动导入。');
}));
node('opImportDictionary').addEventListener('click',event=>void task(event.target,async()=>{
  const {file,text}=await readJsonFile('opDictionaryFile');await request('/dictionary/import','POST',{filename:file.name,content:text,packageType:node('opDictionaryType').value});await refresh(true);notify('词库包已导入，请选择该包并保存游戏设置以启用。');
}));
document.querySelectorAll('[data-game-action]').forEach(button=>button.addEventListener('click',()=>void task(button,async()=>{
  await request('/game/control','POST',{action:button.dataset.gameAction});await refresh(false,true);notify('游戏状态已更新，直播连接与登录态不变。');
})));
node('opGameForm').addEventListener('submit',event=>{event.preventDefault();void task(event.submitter,async()=>{
  if(!confirm('保存将取消本局未完成任务并新开一局，保留积分。继续吗？'))return;
  const n=id=>Number(node(id).value);
  await request('/game','PUT',{
    revision:gameRevision,
    game:{language:node('gLanguage').value,dictionaryPackageId:node('gDictionary').value,answer:node('gAnswer').value.trim(),roundDurationMs:Math.round(n('gDuration')*1000),settlementDurationMs:Math.round(n('gSettlement')*1000),allowLocalGiftFallback:node('gLocalFallback').checked},
    llm:{baseUrl:node('gApi').value.trim(),routingMode:node('gRouting').value,preferredModel:node('gPreferred').value.trim(),fallbackModels:node('gFallbacks').value.split(',').map(s=>s.trim()).filter(Boolean),fixedModel:node('gFixed').value.trim(),timeoutMs:n('gTimeout'),batchSize:n('gBatch')},
    presentation:{timedHints:node('gTimedHints').checked,directionHint:node('gDirection').value.trim(),winnerPoints:n('gWinner'),secondPoints:n('gSecond'),thirdPoints:n('gThird'),assistPoints:n('gAssist')}
  });await refresh(true);notify('抖音游戏设置已保存并新开一局，TikTok 配置未修改。');
});});
node('sGiftSelect').addEventListener('change',()=>{
  const gift=data.catalog.gifts.find(g=>g.id===node('sGiftSelect').value);if(gift){node('sGiftId').value=gift.id;node('sPrice').value=gift.price??'';}
});
node('opSimulateForm').addEventListener('submit',event=>{event.preventDefault();void task(event.submitter,async()=>{
  const input={trigger:node('sTrigger').value,giftId:node('sGiftId').value.trim(),quantity:Number(node('sQuantity').value)};
  if(node('sPrice').value!=='')input.unitPrice=Number(node('sPrice').value);
  const {plan}=await request('/simulate','POST',input);
  node('opSimulation').innerHTML=`<strong>匹配：${escape(plan.ruleName)}</strong><br>随机词 ${plan.randomWords} 个 · 加时 ${plan.extraTimeMs/1000} 秒 · 解锁提示 ${Math.min(4,plan.hints)} 条（最多 4 条）<br>${plan.randomWords?`词汇来源：${plan.wordSource==='llm'?'AI 生成':'本地词库'} · `:''}总价值：${plan.totalValue??'未提供'}<br>${escape(plan.note||'仅规则预演；未触发真实游戏。')}`;
});});
globalThis.douyinOperations={onStatus(status){
  const cookie=status.douyin?.webcastConnection?.cookie;
  node('opAccount').textContent=cookie?.hasLoginSession
    ? cookie.storage==='encrypted-local' ? '账号：已记住登录（平台有效性待验证）' : '账号：仅本次运行可用（查看保存状态）'
    : cookie?.persistence?.state==='error' ? '账号：登录缓存需处理' : '账号：未提供登录态';
  const room=status.douyin?.webcast?.webRid||status.roomId||'';
  if(room!==lastRoom){lastRoom=room;void refresh();}
}};
void refresh();
setInterval(()=>{if(!document.hidden)void refresh();},5000);
setInterval(()=>{if(!document.hidden&&document.querySelector('[data-ops-tab="events"]')?.classList.contains('active'))void refreshEvents();},1500);
