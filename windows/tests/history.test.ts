import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../electron/history.ts';
import { createAgentConversation, runAgent } from '../electron/agent.ts';
import { DEFAULT_PROMPTS } from '../electron/prompts.ts';
import type { AgentRequest, CaptureImage, PrivateSettings } from '../electron/contracts.ts';

async function fixture(t: TestContext, limit = 10) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabbitball-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new HistoryStore(directory, limit);
  await store.load();
  const reload = async () => { const next = new HistoryStore(directory, limit); await next.load(); return next; };
  return { store, reload, directory };
}

function request(id = 'conversation-1', turnId = 'turn-1'): AgentRequest {
  return { id: 'request-' + turnId, conversationId: id, turnId, text: '解释这张截图', action: 'ask' };
}

function conversation() {
  const state = createAgentConversation();
  state.prompts = { ...DEFAULT_PROMPTS };
  state.messages = [
    { role: 'system', content: DEFAULT_PROMPTS.system },
    { role: 'user', content: [{ type: 'text', text: '解释这张截图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,c2NyZWVu', detail: 'high' } }] },
    { role: 'assistant', content: null, reasoning_content: '需要保留的完整推理', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_web', arguments: '{"query":"牛顿"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{"results":[{"title":"文献","url":"https://example.com"}]}' },
    { role: 'assistant', content: '牛顿第二定律', reasoning_content: '最后一轮推理' },
  ];
  state.turns = [{ id: 'turn-1', userEnd: 2, action: 'ask' }];
  state.committedLength = state.messages.length;
  return state;
}

function response(text: string): Response {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

const settings = { prompts: DEFAULT_PROMPTS, apiKey: 'settings-secret-must-not-persist', apiBaseUrl: 'https://example.com', model: 'test', maxToolRounds: 3, reasoning: 'medium' } as PrivateSettings;

test('空历史不写盘；详情保存首图，列表只返回缩略图，完整上下文不暴露给 renderer', async t => {
  const { store, reload, directory } = await fixture(t);
  assert.deepEqual(store.list(), []);
  await assert.rejects(readFile(path.join(directory, 'history.json')), { code: 'ENOENT' });
  const screenshot: CaptureImage = { id: 'screen-1', title: '初始窗口', imageDataUrl: 'data:image/png;base64,c2NyZWVu' };
  const run = store.begin(request(), conversation(), screenshot, 'data:image/jpeg;base64,c21hbGw=');
  run.onEvent({ id: 'request-turn-1', type: 'done', text: '牛顿第二定律' });
  await run.save();
  screenshot.title = '外部修改';
  const restored = await reload();
  assert.deepEqual(restored.getConversation('conversation-1'), conversation());
  const visible = restored.get('conversation-1')!;
  assert.equal(visible.firstScreenshot?.title, '初始窗口');
  assert.equal(visible.messages[1].content, '牛顿第二定律');
  assert.equal('conversation' in visible, false);
  assert.equal('firstScreenshot' in restored.list()[0], false);
  assert.equal(restored.list()[0].thumbnail, 'data:image/jpeg;base64,c21hbGw=');
  assert.equal(JSON.stringify(visible).includes('完整推理'), false);
});

test('重启后的续聊原样发送原图、推理与工具链，重新生成保留目标 user 前缀', async t => {
  const { store, reload, directory } = await fixture(t);
  const initial = conversation(), initialRun = store.begin(request(), initial);
  initialRun.onEvent({ id: 'request-turn-1', type: 'done', text: '牛顿第二定律' });
  await initialRun.save();
  const restored = await reload(), state = restored.getConversation('conversation-1')!;
  const fetchBefore = globalThis.fetch;
  const sent: Array<{ messages: unknown[] }> = [];
  globalThis.fetch = async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return response('继续解释'); };
  t.after(() => { globalThis.fetch = fetchBefore; });
  const next = { ...request('conversation-1', 'turn-2'), text: '再解释一下' };
  const run = restored.begin(next, state);
  await runAgent(next, settings, { signal: new AbortController().signal, conversation: state, onEvent: run.onEvent });
  await run.save();
  assert.deepEqual(sent[0].messages.slice(0, initial.messages.length), initial.messages);
  assert.equal(restored.get('conversation-1')?.messages.length, 4);
  const regenerate = { ...request(), regenerate: true }, again = restored.begin(regenerate, state);
  await runAgent(regenerate, settings, { signal: new AbortController().signal, conversation: state, onEvent: again.onEvent });
  await again.save();
  assert.deepEqual(sent[1].messages, initial.messages.slice(0, 2));
  assert.equal(restored.get('conversation-1')?.messages.length, 2);
  assert.equal((await reload()).getConversation('conversation-1')?.turns.length, 1);
  assert.equal((await readFile(path.join(directory, 'history.json'), 'utf8')).includes(settings.apiKey), false);
});

test('删除与排队写入保持顺序，迟到完成或取消不会复活已删记录', async t => {
  const { store, reload } = await fixture(t);
  const run = store.begin(request(), conversation());
  const firstWrite = run.save();
  const deletion = store.delete('conversation-1');
  run.onEvent({ id: 'request-turn-1', type: 'done', text: '迟到回答' });
  await Promise.all([firstWrite, deletion, run.save()]);
  assert.deepEqual(store.list(), []);
  assert.deepEqual((await reload()).list(), []);
});

test('按最近活动排序；减小限制立即持久裁剪，裁掉的旧请求不得迟到写回', async t => {
  const { store, reload } = await fixture(t, 3);
  const old = store.begin(request('old'), conversation()); await old.save();
  const middle = store.begin(request('middle'), conversation()); await middle.save();
  const newest = store.begin(request('newest'), conversation()); await newest.save();
  assert.deepEqual(store.list().map(entry => entry.id), ['newest', 'middle', 'old']);
  const revisit = store.begin(request('middle', 'turn-2'), conversation()); await revisit.save();
  assert.deepEqual(store.list().map(entry => entry.id), ['middle', 'newest', 'old']);
  await store.setLimit(1);
  old.onEvent({ id: 'request-turn-1', type: 'cancelled' }); await old.save();
  assert.deepEqual((await reload()).list().map(entry => entry.id), ['middle']);
});

test('取消保存已显示正文并剔除未提交工具调用；同会话的旧回调不覆盖新轮次', async t => {
  const { store, reload } = await fixture(t);
  const state = conversation();
  state.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'pending', type: 'function', function: { name: 'search_web', arguments: '{}' } }] });
  const run = store.begin(request(), state);
  run.onEvent({ id: 'request-turn-1', type: 'delta', text: '已显示的部分' });
  run.onEvent({ id: 'request-turn-1', type: 'cancelled' });
  await run.save();
  const disk = await reload();
  assert.equal(disk.get('conversation-1')?.messages[1].status, 'cancelled');
  assert.equal(disk.get('conversation-1')?.messages[1].content, '已显示的部分');
  assert.equal(disk.getConversation('conversation-1')?.messages.length, state.committedLength);
  const next = store.begin(request('conversation-1', 'turn-2'), state);
  next.onEvent({ id: 'request-turn-2', type: 'done', text: '新回复' }); await next.save();
  run.onEvent({ id: 'request-turn-1', type: 'done', text: '旧回复' }); await run.save();
  assert.equal((await reload()).get('conversation-1')?.messages[3].content, '新回复');
});
