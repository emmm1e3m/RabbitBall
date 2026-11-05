import type { AgentEvent, AgentRequest, CaptureContext, PrivateSettings, PromptSettings } from './contracts.js'

type Source = { title: string; url: string }
type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'high' } }
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  reasoning_content?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface AgentOptions {
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  context?: CaptureContext
  conversation: AgentConversation
}

export interface AgentConversation {
  prompts: PromptSettings | null
  messages: Message[]
  turns: Array<{ id: string; userEnd: number; action: AgentRequest['action'] }>
  generation: number
  committedLength: number
}

export function createAgentConversation(): AgentConversation {
  return { prompts: null, messages: [], turns: [], generation: 0, committedLength: 0 }
}

const MAX_TOOL_ROUNDS = 3
const REQUEST_TIMEOUT = 180_000
// 预算包含内部思考；不低于当前 max 强度的默认值，避免反向缩短长回答。
const MAX_OUTPUT_TOKENS = 131_072
const reasoningEffort = { low: 'low', medium: 'high', high: 'max' } as const
function searchTool(prompts: PromptSettings) { return {
  type: 'function',
  function: {
    name: 'search_web',
    description: prompts.searchTool,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
} }

class AgentError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function inputMessage(request: AgentRequest, context: CaptureContext | undefined, hasPreviousInput: boolean, prompts: PromptSettings): Message {
  const text = request.text.trim()
  const parts: ContentPart[] = text ? [{ type: 'text', text }] : []
  if (request.action === 'search' || request.action === 'extract' || request.action === 'translate') parts.push({ type: 'text', text: prompts[request.action] })
  if (!parts.length) parts.push({ type: 'text', text: prompts.fallback })
  for (const [index, image] of (context?.images ?? []).entries()) {
    let description = `第${index + 1}张截图信息（数据）：${JSON.stringify({ title: image.title })}`
    const cursor = image.cursor
    if (cursor) description += `\n指针信息（截图像素坐标；inside表示是否位于截图范围内）：${JSON.stringify(cursor)}`
    parts.push({ type: 'text', text: description }, { type: 'image_url', image_url: { url: image.imageDataUrl, detail: 'high' } })
  }
  if (!context?.images.length && context?.error) parts.push({ type: 'text', text: '屏幕采集状态（数据）：本次采集未成功，没有提供截图。' })
  for (const attachment of request.attachments ?? []) {
    parts.push({ type: 'text', text: `以下为用户附件数据，文件名：${JSON.stringify(attachment.name)}` })
    if (attachment.text !== undefined) parts.push({ type: 'text', text: attachment.text.slice(0, 60_000) })
    else if (attachment.dataUrl && attachment.mimeType.startsWith('image/')) parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl, detail: 'high' } })
    else throw new AgentError('附件无法读取，请重新选择图片或文本文件。')
  }
  if ((request.action === 'extract' || request.action === 'translate') && !context?.images.length && !request.attachments?.length && !hasPreviousInput) {
    throw new AgentError('请先选择屏幕截图或添加文件，再提取或翻译文字。')
  }
  return { role: 'user', content: parts }
}

function endpoint(base: string, path: string): string {
  const root = (base.trim() || 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/v1$/, '')
  let url: URL
  try { url = new URL(root) } catch { throw new AgentError('DeepSeek API 地址无效，请在设置中填写完整地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) throw new AgentError('DeepSeek API 地址应为 HTTP 或 HTTPS 基础地址，不包含查询参数。')
  return root + path
}

async function post(settings: PrivateSettings, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  active(signal)
  const response = await fetch(endpoint(settings.apiBaseUrl, path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  })
  if (!response.ok) {
    const labels: Record<number, string> = {
      400: '请求参数未被接受，请检查模型与 API 地址设置',
      401: 'API Key 无效或已失效，请在设置中更新',
      402: '账户余额不足，请检查 DeepSeek 账户',
      403: '当前 API Key 没有此接口的访问权限',
      404: '接口地址不存在，请检查 API 基础地址和模型设置',
      429: '请求过于频繁，请稍后重试',
    }
    // 不向界面转发原始错误体，避免第三方服务回显认证信息和输入内容。
    void response.body?.cancel().catch(() => {})
    throw new AgentError(`DeepSeek ${path.includes('/tools/') ? '搜索' : '对话'}失败（HTTP ${response.status}）：${labels[response.status] ?? (response.status >= 500 ? '服务暂时不可用，请稍后重试' : '服务未能处理请求，请检查设置后重试')}。`)
  }
  return response
}

async function streamMessage(response: Response, signal: AbortSignal, onText: (text: string) => void): Promise<Message> {
  if (!response.body) throw new AgentError('模型没有返回可读取的响应流，请重试。')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const calls = new Map<number, ToolCall>()
  let buffer = '', content = '', reasoning = '', done = false, finish = ''
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  function event(frame: string): void {
    active(signal)
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return
    if (data.trim() === '[DONE]') { done = true; return }
    let payload: Record<string, unknown>
    try { payload = record(JSON.parse(data)) } catch { throw new AgentError('模型响应格式异常，请重新发送。') }
    if (payload.error) throw new AgentError('模型生成中断，请稍后重试。')
    if (!Array.isArray(payload.choices) || !payload.choices.length) return
    const choice = record(payload.choices[0]), delta = record(choice.delta)
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    if (typeof delta.content === 'string' && delta.content) { content += delta.content; onText(delta.content) }
    if (Array.isArray(delta.tool_calls)) for (const item of delta.tool_calls) {
      const part = record(item), index = part.index
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 7) throw new AgentError('模型返回了无效的工具调用。')
      const call = calls.get(index as number) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      const fn = record(part.function)
      if (typeof part.id === 'string') call.id += part.id
      if (typeof fn.name === 'string') call.function.name += fn.name
      if (typeof fn.arguments === 'string') call.function.arguments += fn.arguments
      calls.set(index as number, call)
    }
    if (typeof choice.finish_reason === 'string') finish = choice.finish_reason
  }
  try {
    while (!done) {
      active(signal)
      const chunk = await reader.read()
      active(signal)
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      let boundary: RegExpMatchArray | null
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        const index = boundary.index!
        event(buffer.slice(0, index)); buffer = buffer.slice(index + boundary[0].length)
        if (done) break
      }
      if (chunk.done) { if (buffer.trim() && !done) event(buffer); break }
    }
    active(signal)
    if (!done && !finish) throw new AgentError('模型连接提前结束，回复尚未完成，请重试。')
    if (finish && !['stop', 'tool_calls'].includes(finish)) throw new AgentError(finish === 'length' ? '回复达到模型长度限制，请缩短问题后重试。' : '模型未能完成回复，请稍后重试。')
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    if (toolCalls.some(call => !call.id || !call.function.name)) throw new AgentError('模型返回了不完整的工具调用，请重试。')
    return { role: 'assistant', content: content || null, reasoning_content: reasoning, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel(); reader.releaseLock()
  }
}

async function search(query: string, settings: PrivateSettings, signal: AbortSignal, sources: Map<string, Source>): Promise<string> {
  const response = await post(settings, '/v1/tools/search', { query, count: 5, need_content: true }, signal)
  const data = record(await response.json())
  active(signal)
  if (!Array.isArray(data.results)) throw new AgentError('搜索服务返回的数据格式异常，请重试。')
  const results = []
  for (const item of data.results.slice(0, 5)) {
    const result = record(item)
    if (typeof result.url !== 'string') continue
    let url: URL
    try { url = new URL(result.url) } catch { continue }
    if (!['http:', 'https:'].includes(url.protocol)) continue
    const source = { title: typeof result.title === 'string' ? result.title.slice(0, 180) : url.hostname, url: url.href }
    sources.set(source.url, source)
    results.push({ ...source,
      snippet: typeof result.snippet === 'string' ? result.snippet.slice(0, 500) : '',
      summary: typeof result.summary === 'string' ? result.summary.slice(0, 1500) : '',
      content: typeof result.content === 'string' ? result.content.slice(0, 6000) : '',
      date: typeof result.date === 'string' ? result.date : null,
    })
  }
  return JSON.stringify({ query, results, ...(results.length ? {} : { note: '没有找到可用网页。' }) })
}

export async function runAgent(request: AgentRequest, settings: PrivateSettings, options: AgentOptions): Promise<void> {
  const emit = (event: Omit<AgentEvent, 'id'>) => options.onEvent({ ...event, id: request.id } as AgentEvent)
  const conversation = options.conversation, generation = ++conversation.generation
  // 新生成先去掉旧生成尚未完成的工具回合，避免迟到请求留下悬空调用。
  conversation.messages.length = conversation.committedLength
  let checkpoint = conversation.committedLength
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal.reason)
  if (options.signal.aborted) abort()
  else options.signal.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT)
  const signal = controller.signal
  const current = () => {
    active(signal)
    if (conversation.generation !== generation) throw new DOMException('已取消', 'AbortError')
  }
  try {
    current()
    // 同一会话固定提示词快照，保存新设置不会改写已经送出的缓存前缀。
    if (conversation.prompts === null) {
      conversation.prompts = { ...settings.prompts }
      conversation.messages.push({ role: 'system', content: conversation.prompts.system })
      conversation.committedLength = checkpoint = 1
    }
    const prompts = conversation.prompts
    emit({ type: 'start' })
    const messages = conversation.messages, sources = new Map<string, Source>()
    let action = request.action
    if (request.regenerate) {
      const index = conversation.turns.findIndex(turn => turn.id === request.turnId)
      if (index < 0) throw new AgentError('找不到需要重新生成的消息，请重新发送问题。')
      const turn = conversation.turns[index]
      // 原样保留目标 user 及其前缀，图片、工具结果和推理都不重建。
      messages.length = turn.userEnd
      conversation.turns.length = index + 1
      action = turn.action
    } else {
      if (conversation.turns.some(turn => turn.id === request.turnId)) throw new AgentError('此问题已经发送，请使用重新生成或发送新问题。')
      const hasPreviousInput = messages.some(message => message.role === 'user')
      messages.push(inputMessage(request, options.context, hasPreviousInput, prompts))
      conversation.turns.push({ id: request.turnId, userEnd: messages.length, action })
    }
    checkpoint = messages.length
    conversation.committedLength = checkpoint
    if (!settings.apiKey.trim()) throw new AgentError('请先在设置中填写 DeepSeek API Key。')
    const canSearch = action !== 'extract' && action !== 'translate'
    let answer = '', separate = false
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      current()
      const forceSearch = action === 'search' && round === 0
      const body = {
        model: settings.model || 'deepseek-flash', messages, stream: true,
        max_tokens: forceSearch ? 8192 : MAX_OUTPUT_TOKENS,
        // 官方接口不允许 thinking 模式强制指定工具；仅搜索规划首轮关闭思考。
        thinking: { type: forceSearch ? 'disabled' : 'enabled' },
        ...(forceSearch ? {} : { reasoning_effort: reasoningEffort[settings.reasoning] }),
        ...(canSearch ? { tools: [searchTool(prompts)], tool_choice: forceSearch ? { type: 'function', function: { name: 'search_web' } } : round === MAX_TOOL_ROUNDS ? 'none' : 'auto' } : {}),
      }
      const response = await post(settings, '/chat/completions', body, signal)
      const message = await streamMessage(response, signal, text => {
        current()
        if (separate) { answer += '\n\n'; emit({ type: 'delta', text: '\n\n' }); separate = false }
        answer += text; emit({ type: 'delta', text })
      })
      current()
      messages.push(message)
      const calls = message.tool_calls ?? []
      if (!calls.length) {
        if (forceSearch) throw new AgentError('模型没有执行要求的联网搜索，请重试。')
        if (typeof message.content !== 'string' || !message.content.trim()) throw new AgentError('模型没有返回可显示的文字，请重试。')
        if (sources.size && ![...sources.keys()].some(url => answer.includes(url))) {
          const links = [...sources.values()].map(source => `[${source.title.replace(/[\\[\]]/g, '\\$&')}](${source.url.replace(/\)/g, '%29')})`)
          const suffix = `\n\n检索来源：${links.join(' · ')}`
          answer += suffix; emit({ type: 'delta', text: suffix })
        }
        current()
        checkpoint = messages.length
        conversation.committedLength = checkpoint
        emit({ type: 'done', text: answer, sources: [...sources.values()] })
        return
      }
      if (!canSearch) throw new AgentError('本次操作不允许联网搜索，请重新发送。')
      if (round === MAX_TOOL_ROUNDS) throw new AgentError('搜索已达到本次调用上限，请缩小问题范围后重试。')
      for (const call of calls) {
        current()
        if (call.function.name !== 'search_web') throw new AgentError('模型请求了未提供的操作，已停止执行。')
        let args: Record<string, unknown>
        try { args = record(JSON.parse(call.function.arguments)) } catch { throw new AgentError('模型生成的搜索参数格式有误，请重试。') }
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (!query || [...query].length > 128) throw new AgentError('搜索词应为1至128个字符，请缩短问题后重试。')
        emit({ type: 'tool', name: 'search_web', message: `正在搜索：${query}` })
        const result = await search(query, settings, signal, sources)
        current()
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
        emit({ type: 'tool', name: 'search_web', message: sources.size ? '正在整理搜索结果' : '没有找到匹配的网页', sources: [...sources.values()] })
      }
      checkpoint = messages.length
      conversation.committedLength = checkpoint
      separate = typeof message.content === 'string' && !!message.content
    }
  } catch (error) {
    // 只提交完整模型消息与完整工具回合，旧生成不能回滚新生成的轨迹。
    if (conversation.generation === generation) conversation.messages.length = checkpoint
    if (options.signal.aborted || conversation.generation !== generation) emit({ type: 'cancelled', message: '已停止' })
    else if (timedOut) emit({ type: 'error', message: '请求超时，请稍后重试或降低思考强度。' })
    else emit({ type: 'error', message: error instanceof AgentError ? error.message : '无法连接或读取 DeepSeek 服务，请检查网络与 API 设置后重试。' })
  } finally {
    clearTimeout(timeout)
    options.signal.removeEventListener('abort', abort)
  }
}
