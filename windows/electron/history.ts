import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentConversation } from './agent.js';
import type { AgentEvent, AgentRequest, CaptureImage, HistoryEntry, HistoryMessage, HistorySummary } from './contracts.js';

interface StoredHistory extends HistoryEntry {
  conversation: AgentConversation;
}

interface HistoryRecord {
  value: StoredHistory;
  run?: symbol;
}

export interface HistoryRun {
  onEvent(event: AgentEvent): void;
  save(): Promise<void>;
}

function summary(entry: HistoryEntry): HistorySummary {
  return { id: entry.id, title: entry.title, updatedAt: entry.updatedAt, ...(entry.thumbnail ? { thumbnail: entry.thumbnail } : {}) };
}

function snapshot(conversation: AgentConversation): AgentConversation {
  // 只保存模型上下文；配置和 API Key 不进入历史。未提交的工具调用不跨重启保留。
  return structuredClone({ prompts: conversation.prompts, messages: conversation.messages.slice(0, conversation.committedLength),
    turns: conversation.turns, generation: conversation.generation, committedLength: conversation.committedLength });
}

export class HistoryStore {
  private readonly records = new Map<string, HistoryRecord>();
  private writes: Promise<void> = Promise.resolve();
  private limit: number;
  private readonly file: string;

  constructor(directory: string, limit: number) {
    this.file = path.join(directory, 'history.json');
    this.limit = limit;
  }

  async load(): Promise<void> {
    let content: string;
    try { content = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const stored = JSON.parse(content) as { version: number; entries: StoredHistory[] };
    if (stored.version !== 1 || !Array.isArray(stored.entries)) throw new Error('历史记录格式无效。');
    for (const entry of stored.entries) this.records.set(entry.id, { value: entry });
    if (this.trim()) await this.persist();
  }

  list(): HistorySummary[] {
    return this.sorted().map(record => summary(record.value));
  }

  get(id: string): HistoryEntry | null {
    const value = this.records.get(id)?.value;
    if (!value) return null;
    // 推理内容及工具原文留在主进程，列表和详情仅返回界面需要的数据。
    return structuredClone({ ...summary(value), messages: value.messages, ...(value.firstScreenshot ? { firstScreenshot: value.firstScreenshot } : {}) });
  }

  getConversation(id: string): AgentConversation | undefined {
    const value = this.records.get(id)?.value;
    return value ? structuredClone(value.conversation) : undefined;
  }

  async delete(id: string): Promise<void> {
    if (this.records.delete(id)) await this.persist();
  }

  async setLimit(limit: number): Promise<void> {
    this.limit = limit;
    if (this.trim()) await this.persist();
  }

  begin(request: AgentRequest, conversation: AgentConversation, firstScreenshot?: CaptureImage, thumbnail?: string): HistoryRun {
    // 关闭历史只停止持久化；正在进行的对话仍由主进程的 AgentConversation 持有。
    if (this.limit === 0) return { onEvent() {}, async save() {} };
    let record = this.records.get(request.conversationId);
    const regenerateIndex = request.regenerate ? record?.value.messages.findIndex(message => message.role === 'assistant' && message.turn.id === request.turnId) ?? -1 : -1;
    if (request.regenerate && regenerateIndex < 0 && !conversation.turns.some(turn => turn.id === request.turnId)) throw new Error('找不到需要重新生成的历史消息。');
    const intent = request.action && request.action !== 'ask' ? request.action : 'chat';
    const turn: HistoryMessage['turn'] = { id: request.turnId, text: request.text, intent };
    if (!record) {
      const title = request.text.trim() || { chat: '附件对话', search: '搜索与解释', extract: '提取文字', translate: '翻译' }[intent];
      record = { value: { id: request.conversationId, title: title.replace(/\s+/g, ' ').slice(0, 80), updatedAt: Date.now(),
        messages: [], conversation: snapshot(conversation), ...(firstScreenshot ? { firstScreenshot: structuredClone(firstScreenshot) } : {}), ...(thumbnail ? { thumbnail } : {}) } };
      this.records.set(request.conversationId, record);
    }
    const entry = record.value;
    if (request.regenerate && regenerateIndex >= 0) {
      entry.messages.length = regenerateIndex;
    } else {
      // 重新启用保存后，内存里可重新生成的旧问题可能尚无历史条目，从本次问题开始记录。
      if (request.regenerate) entry.messages.length = 0;
      entry.messages.push({ role: 'user', content: request.text, turn, status: 'complete', ...(!request.text.trim() && intent !== 'chat' ? { hidden: true } : {}) });
    }
    // 写盘时将尚在生成的回复视为已停止，意外退出后不会恢复成永远等待的状态。
    const response: HistoryMessage = { role: 'assistant', content: '', turn, status: 'cancelled' };
    entry.messages.push(response);
    entry.updatedAt = this.nextActivityTime();
    this.trim();
    const token = Symbol();
    record.run = token;
    let finished = false;
    const current = () => this.records.get(entry.id) === record && record.run === token;
    return {
      onEvent: event => {
        if (!current() || finished) return;
        if (event.type === 'delta') response.content += event.text || '';
        else if (event.type === 'done') {
          response.content = event.text ?? response.content;
          response.status = 'complete';
          if (event.sources?.length) response.sources = event.sources;
          finished = true;
        } else if (event.type === 'error') {
          response.status = 'error'; response.content = event.message || '请求未完成。'; finished = true;
        } else if (event.type === 'cancelled') { response.status = 'cancelled'; finished = true; }
      },
      save: () => {
        // 删除、裁剪或同会话的新一轮生成会撤销旧写入权，迟到回调不能复活记录。
        if (!current()) return Promise.resolve();
        entry.conversation = snapshot(conversation);
        entry.updatedAt = this.nextActivityTime();
        return this.persist();
      },
    };
  }

  flush(): Promise<void> { return this.writes; }

  private nextActivityTime(): number {
    return Math.max(Date.now(), ...[...this.records.values()].map(record => record.value.updatedAt + 1));
  }

  private sorted(): HistoryRecord[] {
    return [...this.records.values()].sort((a, b) => b.value.updatedAt - a.value.updatedAt);
  }

  private trim(): boolean {
    const expired = this.sorted().slice(this.limit);
    for (const record of expired) this.records.delete(record.value.id);
    return expired.length > 0;
  }

  private persist(): Promise<void> {
    // 先取不可变快照，再串行原子替换，删除和裁剪与先前排队的写入保持顺序。
    const content = JSON.stringify({ version: 1, entries: this.sorted().map(record => record.value) });
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', content, 'utf8');
      await rename(this.file + '.tmp', this.file);
    });
    this.writes = write;
    return write;
  }
}
