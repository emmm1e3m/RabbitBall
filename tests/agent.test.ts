import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentConversation, runAgent } from '../electron/agent.ts'
import type { AgentConversation } from '../electron/agent.ts'
import type { AgentEvent, AgentRequest, CaptureContext, PrivateSettings } from '../electron/contracts.ts'
import { DEFAULT_PROMPTS } from '../electron/prompts.ts'

const settings = {
  bodyColor: '#F79ABB', eyeColor: '#F90040', petSize: 1,
  launchAtLogin: false, pauseOnFullscreen: true, followMouse: true, autoCopyScreenshots: true,
  reasoning: 'medium', apiBaseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash', apiKey: 'test-only-key',
  prompts: { ...DEFAULT_PROMPTS },
} as PrivateSettings

function sse(deltas: unknown[], finish = 'stop', complete = true): Response {
  const data = ': keep-alive\r\n\r\n' + deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\r\n\r\n`).join('') +
    (complete ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\r\n\r\ndata: [DONE]\r\n\r\n` : '')
  const bytes = new TextEncoder().encode(data)
  // 故意从 JSON、CRLF 与中文 UTF-8 字节中间拆分，验证真实流的任意边界。
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const sizes = [1, 2, 7, 3, 19]
      for (let offset = 0, index = 0; offset < bytes.length; index++) {
        const end = Math.min(bytes.length, offset + sizes[index % sizes.length])
        controller.enqueue(bytes.slice(offset, end)); offset = end
      }
      controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}

function toolReply(query = '兔球 官方文档', reasoning = '仅在服务端保留的推理'): Response {
  return sse([
    { reasoning_content: reasoning },
    { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_', arguments: '{"query":' } }] },
    { tool_calls: [{ index: 0, function: { name: 'web', arguments: JSON.stringify(query) + '}' } }] },
  ], 'tool_calls')
}

async function mocked(fetcher: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = fetcher
  try { await run() } finally { globalThis.fetch = original }
}

async function collect(request: Partial<AgentRequest> = {}, customSettings = settings, context?: CaptureContext, conversation = createAgentConversation()): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  await runAgent({ id: 'request-1', conversationId: 'conversation-1', turnId: 'turn-1', text: '请解释一下', action: 'ask', ...request }, customSettings, {
    signal: new AbortController().signal, onEvent: event => events.push(event), context, conversation,
  })
  return events
}

test('SSE 可跨字节拆包，思考强度映射正确且不向界面发送 reasoning', async () => {
  for (const [level, effort] of [['low', 'low'], ['medium', 'high'], ['high', 'max']] as const) {
    await mocked(async (url, init) => {
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.reasoning_effort, effort)
      assert.deepEqual(body.thinking, { type: 'enabled' })
      return sse([{ reasoning_content: '秘密思考内容' }, { content: '你好，' }, { content: '兔球。' }])
    }, async () => {
      const events = await collect({}, { ...settings, reasoning: level })
      assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '你好，兔球。')
      assert.equal(events.at(-1)?.type, 'done')
      assert.equal(events.at(-1)?.text, '你好，兔球。')
      assert.ok(!JSON.stringify(events).includes('秘密思考内容'))
    })
  }
})

test('请求使用已选模型，并独立保留思考强度', async () => {
  await mocked(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'deepseek-v4-pro')
    assert.equal(body.reasoning_effort, 'max')
    return sse([{ content: '回答。' }])
  }, async () => {
    const events = await collect({}, { ...settings, model: 'deepseek-v4-pro', reasoning: 'high' })
    assert.equal(events.at(-1)?.type, 'done')
  })
})

test('搜索快捷动作先用图片上下文生成 query，搜索后恢复 thinking 并保留内部推理', async () => {
  const calls: Array<{ url: string; body: Record<string, any> }> = []
  const context: CaptureContext = { id: 'screen', title: '浏览器', capturedAt: 1,
    images: [{ id: 'screen-image', title: '浏览器', imageDataUrl: 'data:image/png;base64,aW1hZ2U=',
      cursor: { x: 120, y: 80, width: 800, height: 600, inside: true } }] }
  await mocked(async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body })
    if (String(url).endsWith('/tools/search')) {
      assert.deepEqual(body, { query: '截图中公司的最新发布', count: 5, need_content: true })
      return Response.json({ results: [{ title: '官方发布', url: 'https://example.org/release', content: '产品刚刚发布。', summary: '发布消息' }] })
    }
    if (calls.length === 1) {
      assert.deepEqual(body.thinking, { type: 'disabled' })
      assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'search_web' } })
      assert.ok(JSON.stringify(body.messages).includes('image_url'))
      assert.ok(body.messages.at(-1).content.some((part: any) => part.type === 'text' && part.text.includes('"x":120')))
      return toolReply('截图中公司的最新发布', '')
    }
    assert.deepEqual(body.thinking, { type: 'enabled' })
    const toolMessage = body.messages.at(-1)
    assert.equal(toolMessage.role, 'tool')
    assert.equal(toolMessage.tool_call_id, 'call_1')
    assert.ok(toolMessage.content.includes('https://example.org/release'))
    assert.equal(body.messages.at(-2).reasoning_content, '')
    return sse([{ reasoning_content: '不会发送给界面的分析' }, { content: '这家公司刚刚发布了产品。' }])
  }, async () => {
    const events = await collect({ action: 'search', text: '搜索并解释鼠标附近的内容' }, settings, context)
    assert.equal(calls.length, 3)
    assert.equal(events.at(-1)?.type, 'done')
    assert.match(events.at(-1)?.text ?? '', /https:\/\/example.org\/release/)
    assert.deepEqual(events.at(-1)?.sources, [{ title: '官方发布', url: 'https://example.org/release' }])
    assert.ok(!JSON.stringify(events).includes('不会发送给界面的分析'))
  })
})

test('追问原样保留多图、工具和 reasoning 前缀，只追加当前 user', async () => {
  let chats = 0, prefix: AgentConversation['messages'] = []
  const conversation = createAgentConversation()
  const context: CaptureContext = { id: 'screen', title: '截图', capturedAt: 1, images: [
    { id: 'selection-1', title: '选区一', imageDataUrl: 'data:image/png;base64,Y2Fub25pY2Fs', cursor: { x: 10, y: 20, width: 100, height: 80, inside: true } },
    { id: 'selection-2', title: '选区二', imageDataUrl: 'data:image/png;base64,c2Vjb25k', cursor: { x: 30, y: 40, width: 200, height: 160, inside: false } },
  ] }
  await mocked(async (url, init) => {
    if (String(url).endsWith('/tools/search')) return Response.json({ results: [{ title: '来源', url: 'https://example.org/data', content: '原始工具结果' }] })
    const body = JSON.parse(String(init?.body))
    if (++chats === 1) {
      const parts = body.messages.at(-1).content
      assert.deepEqual(parts.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url), context.images.map(image => image.imageDataUrl))
      const imageIndices = parts.flatMap((part: any, index: number) => part.type === 'image_url' ? [index] : [])
      assert.ok(parts[imageIndices[0] - 1].text.includes('选区一'))
      assert.ok(parts[imageIndices[0] - 1].text.includes('"x":10'))
      assert.ok(parts[imageIndices[1] - 1].text.includes('选区二'))
      assert.ok(parts[imageIndices[1] - 1].text.includes('"x":30'))
      return toolReply()
    }
    if (chats === 2) {
      assert.equal(body.messages.at(-2).reasoning_content, '仅在服务端保留的推理')
      assert.equal(body.messages.at(-1).role, 'tool')
      return sse([{ reasoning_content: '第一轮答案推理' }, { content: '第一轮答案。' }])
    }
    assert.deepEqual(body.messages.slice(0, prefix.length), prefix)
    assert.equal(body.messages.length, prefix.length + 1)
    assert.equal(body.messages.at(-1).content[0].text, '继续解释刚才的公式')
    assert.equal((JSON.stringify(body.messages).match(/"type":"image_url"/g) ?? []).length, 2)
    return sse([{ reasoning_content: '追问答案推理' }, { content: '追问答案。' }])
  }, async () => {
    const events = await collect({}, settings, context, conversation)
    assert.equal(events.at(-1)?.type, 'done')
    assert.ok(!JSON.stringify(events).includes('仅在服务端保留的推理'))
    prefix = structuredClone(conversation.messages)
    assert.ok(prefix.some(message => message.role === 'tool' && String(message.content).includes('原始工具结果')))
    assert.ok(prefix.some(message => message.reasoning_content === '第一轮答案推理'))
    const followup = await collect({ id: 'request-2', turnId: 'turn-2', text: '继续解释刚才的公式' }, settings, undefined, conversation)
    assert.equal(followup.at(-1)?.type, 'done')
    assert.deepEqual(conversation.messages.slice(0, prefix.length), prefix)
  })
})

test('重新生成指定 turn 时保留原 user 多图和顺序，不改写消息或重复插图', async () => {
  const conversation = createAgentConversation()
  let calls = 0, originalInput: AgentConversation['messages'] = []
  const context: CaptureContext = { id: 'screen', title: '截图', capturedAt: 1, images: [
    { id: 'selection-1', title: '选区一', imageDataUrl: 'data:image/png;base64,b3JpZ2luYWw=' },
    { id: 'selection-2', title: '选区二', imageDataUrl: 'data:image/png;base64,c2Vjb25k' },
  ] }
  await mocked(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++
    if (calls === 1) originalInput = structuredClone(body.messages)
    if (calls === 3) {
      assert.deepEqual(body.messages, originalInput)
      assert.equal(body.tool_choice, 'auto')
      assert.equal((JSON.stringify(body.messages).match(/"type":"image_url"/g) ?? []).length, 2)
    }
    return sse([{ reasoning_content: `推理${calls}` }, { content: `答案${calls}` }])
  }, async () => {
    assert.equal((await collect({ text: '最初的原问题' }, settings, context, conversation)).at(-1)?.type, 'done')
    assert.equal((await collect({ id: 'request-2', turnId: 'turn-2', text: '第二条问题' }, settings, undefined, conversation)).at(-1)?.type, 'done')
    const regenerated = await collect({ id: 'request-3', turnId: 'turn-1', regenerate: true, text: '不得用这段重写原问题', action: 'search' }, settings, undefined, conversation)
    assert.equal(regenerated.at(-1)?.text, '答案3')
    assert.deepEqual(conversation.messages.slice(0, originalInput.length), originalInput)
    assert.deepEqual(conversation.turns.map(turn => turn.id), ['turn-1'])
    assert.ok(!JSON.stringify(conversation.messages).includes('第二条问题'))
    assert.ok(!JSON.stringify(conversation.messages).includes('答案1'))
  })
})

test('提取与翻译只处理附件，不提供搜索工具', async () => {
  for (const action of ['extract', 'translate'] as const) {
    await mocked(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.tools, undefined)
      assert.ok(JSON.stringify(body.messages).includes('附件正文'))
      assert.ok(JSON.stringify(body.messages).includes('不联网搜索'))
      return sse([{ content: '附件中的文字。' }])
    }, async () => {
      const events = await collect({ action, attachments: [{ id: 'file', name: '例子.txt', mimeType: 'text/plain', text: '附件正文' }] })
      assert.equal(events.at(-1)?.type, 'done')
      assert.ok(!events.some(event => event.type === 'tool'))
    })
  }
})

test('取消正在读取的响应会关闭流，不返回 done 或继续调用工具', async () => {
  const controller = new AbortController(), events: AgentEvent[] = []
  let cancelled = false, calls = 0
  await mocked(async () => {
    calls++
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\ndata: {"choices":[{"delta":{"content":"不应再显示"}}]}\n\n')) },
      cancel() { cancelled = true },
    }))
  }, async () => {
    await runAgent({ id: 'abort', conversationId: 'conversation', turnId: 'turn', text: '问题' }, settings, {
      signal: controller.signal,
      conversation: createAgentConversation(),
      onEvent(event) { events.push(event); if (event.type === 'delta') controller.abort() },
    })
    assert.equal(calls, 1)
    assert.equal(cancelled, true)
    assert.equal(events.at(-1)?.type, 'cancelled')
    assert.equal(events.filter(event => event.type === 'delta').length, 1)
    assert.ok(!events.some(event => event.type === 'done'))
  })
})

test('取消未完成工具回合后新问题可继续，迟到响应不能覆盖新轨迹', async () => {
  const conversation = createAgentConversation(), controller = new AbortController()
  const oldEvents: AgentEvent[] = []
  let startSearch!: () => void, finishSearch!: (response: Response) => void, chats = 0
  const searchStarted = new Promise<void>(resolve => { startSearch = resolve })
  const pendingSearch = new Promise<Response>(resolve => { finishSearch = resolve })
  await mocked(async (url, init) => {
    if (String(url).endsWith('/tools/search')) { startSearch(); return pendingSearch }
    if (++chats === 1) return toolReply()
    const messages = JSON.parse(String(init?.body)).messages
    assert.ok(!messages.some((message: any) => message.tool_calls || message.role === 'tool'))
    return sse([{ content: '新问题答案。' }])
  }, async () => {
    const previous = runAgent({ id: 'old', conversationId: 'conversation', turnId: 'old-turn', text: '旧问题' }, settings, {
      signal: controller.signal, conversation, onEvent: event => oldEvents.push(event),
    })
    await searchStarted
    controller.abort()
    const events = await collect({ id: 'new', turnId: 'new-turn', text: '新问题' }, settings, undefined, conversation)
    assert.equal(events.at(-1)?.type, 'done')
    const committed = structuredClone(conversation.messages)
    finishSearch(Response.json({ results: [{ title: '迟到结果', url: 'https://example.org/late' }] }))
    await previous
    assert.equal(oldEvents.at(-1)?.type, 'cancelled')
    assert.deepEqual(conversation.messages, committed)
    assert.ok(!JSON.stringify(conversation.messages).includes('迟到结果'))
  })
})

test('工具至多运行三回合，最后请求禁用工具', async () => {
  let chats = 0, searches = 0
  await mocked(async (url, init) => {
    if (String(url).endsWith('/tools/search')) { searches++; return Response.json({ results: [] }) }
    const body = JSON.parse(String(init?.body)); chats++
    if (chats === 4) { assert.equal(body.tool_choice, 'none'); return sse([{ content: '目前没有足够依据。' }]) }
    return toolReply()
  }, async () => {
    const events = await collect()
    assert.equal(chats, 4); assert.equal(searches, 3)
    assert.equal(events.at(-1)?.type, 'done')
  })
})

test('断流给出明确错误，缺少密钥不发请求，服务错误不回显秘密', async () => {
  await mocked(async () => sse([{ content: '未完成' }], 'stop', false), async () => {
    const events = await collect()
    assert.equal(events.at(-1)?.type, 'error')
    assert.match(events.at(-1)?.message ?? '', /提前结束/)
  })
  await mocked(async () => { throw new Error('不应发出网络请求') }, async () => {
    const events = await collect({}, { ...settings, apiKey: '' })
    assert.equal(events.at(-1)?.type, 'error')
    assert.match(events.at(-1)?.message ?? '', /API Key/)
  })
  await mocked(async () => Response.json({ error: { message: settings.apiKey } }, { status: 401 }), async () => {
    const events = await collect()
    assert.equal(events.at(-1)?.type, 'error')
    assert.match(events.at(-1)?.message ?? '', /HTTP 401/)
    assert.ok(!JSON.stringify(events).includes(settings.apiKey))
  })
})

test('自定义提示词用于系统、搜索规划与工具，并在同一会话固定原始前缀', async () => {
  const promptsA = { ...DEFAULT_PROMPTS, system: '系统 A：直接回答。', search: '规划 A：先查准确来源。', searchTool: '工具 A：需要外部信息时查询公开资料，使用具体关键词。', fallback: '问题 A：处理附件。' }
  const promptsB = { ...promptsA, system: '系统 B：新对话规则。', searchTool: '工具 B：使用新规则。', fallback: '问题 B：处理附件。' }
  const conversation = createAgentConversation(), bodies: any[] = []
  await mocked(async (url, init) => {
    if (String(url).endsWith('/tools/search')) return Response.json({ results: [] })
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    return bodies.length === 1 ? toolReply('公开测试查询') : sse([{ content: '公开测试结果。' }])
  }, async () => {
    assert.equal((await collect({ action: 'search', text: '', turnId: 'prompt-a' }, { ...settings, prompts: promptsA }, undefined, conversation)).at(-1)?.type, 'done')
    assert.equal(bodies[0].messages[0].content, promptsA.system)
    assert.deepEqual(bodies[0].messages[1].content.map((part: any) => part.text), [promptsA.search])
    assert.equal(bodies[0].tools[0].function.description, promptsA.searchTool)
    assert.deepEqual(bodies[0].tools[0].function.parameters.properties.query, { type: 'string', minLength: 1, maxLength: 128 })
    const prefix = JSON.parse(JSON.stringify(conversation.messages))
    assert.equal((await collect({ text: '继续回答', turnId: 'prompt-follow-up' }, { ...settings, prompts: promptsB }, undefined, conversation)).at(-1)?.type, 'done')
    assert.deepEqual(bodies.at(-1).messages.slice(0, prefix.length), prefix)
    assert.equal(bodies.at(-1).tools[0].function.description, promptsA.searchTool)
    assert.equal((await collect({ text: '', turnId: 'prompt-new' }, { ...settings, prompts: promptsB })).at(-1)?.type, 'done')
    assert.equal(bodies.at(-1).messages[0].content, promptsB.system)
    assert.equal(bodies.at(-1).messages[1].content[0].text, promptsB.fallback)
    assert.equal(bodies.at(-1).tools[0].function.description, promptsB.searchTool)
  })
})

test('自定义提取与翻译指令生效，工具权限仍由动作类型控制', async () => {
  for (const action of ['extract', 'translate'] as const) {
    for (const text of ['', '只处理第一段']) {
      const prompts = { ...DEFAULT_PROMPTS, [action]: '按用户自定义规则处理原文。' }
      await mocked(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        assert.equal(body.tools, undefined)
        const texts = body.messages[1].content.filter((part: any) => part.type === 'text').map((part: any) => part.text)
        assert.equal(texts.filter((value: string) => value === prompts[action]).length, 1)
        assert.equal(texts[0], text || prompts[action])
        assert.ok(!texts.includes(prompts.fallback))
        return sse([{ content: '处理完成。' }])
      }, async () => {
        const events = await collect({ action, text, attachments: [{ id: 'text', name: 'public.txt', mimeType: 'text/plain', text: 'public sample' }] }, { ...settings, prompts })
        assert.equal(events.at(-1)?.type, 'done')
      })
    }
  }
})
