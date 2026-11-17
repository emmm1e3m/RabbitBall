import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TokenUsage, UsageReport, UsageScope, UsageSummary } from './contracts.js';

interface StoredUsage { scope: UsageScope; summary: UsageSummary }

const TOKEN_FIELDS = ['promptTokens', 'completionTokens', 'totalTokens'] as const;
const OPTIONAL_FIELDS = ['cacheHitTokens', 'cacheMissTokens', 'reasoningTokens'] as const;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('用量数值必须是非负安全整数。');
  return value;
}

export function validateUsageScope(input: unknown): UsageScope | undefined {
  if (input === undefined || input === null) return undefined;
  const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
  if (object(input)) {
    if (input.kind === 'graph' && id(input.workspaceId) && id(input.graphId)) return { kind: 'graph', workspaceId: input.workspaceId, graphId: input.graphId };
    if (input.kind === 'chat' && id(input.conversationId)) return { kind: 'chat', conversationId: input.conversationId };
  }
  throw new Error('用量查询范围无效。');
}

function emptySummary(): UsageSummary {
  return { requestCount: 0, reportedRequestCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReportedRequestCount: 0 };
}

function validateTokens(input: unknown): TokenUsage {
  if (!object(input)) throw new Error('用量记录格式无效。');
  const usage: TokenUsage = { promptTokens: count(input.promptTokens), completionTokens: count(input.completionTokens), totalTokens: count(input.totalTokens) };
  for (const field of OPTIONAL_FIELDS) if (input[field] !== undefined) usage[field] = count(input[field]);
  return usage;
}

function validateSummary(input: unknown): UsageSummary {
  if (!object(input)) throw new Error('用量汇总格式无效。');
  const summary: UsageSummary = { ...validateTokens(input), requestCount: count(input.requestCount), reportedRequestCount: count(input.reportedRequestCount), cacheReportedRequestCount: count(input.cacheReportedRequestCount) };
  if (summary.reportedRequestCount > summary.requestCount || summary.cacheReportedRequestCount > summary.reportedRequestCount
    || (summary.cacheReportedRequestCount > 0 && (summary.cacheHitTokens === undefined || summary.cacheMissTokens === undefined))
    || (summary.cacheReportedRequestCount === 0 && (summary.cacheHitTokens !== undefined || summary.cacheMissTokens !== undefined))) throw new Error('用量汇总计数不一致。');
  return summary;
}

function scopeKey(scope: UsageScope): string {
  return JSON.stringify(scope.kind === 'graph' ? ['graph', scope.workspaceId, scope.graphId] : ['chat', scope.conversationId]);
}

function addSummary(target: UsageSummary, value: UsageSummary): void {
  for (const field of ['requestCount', 'reportedRequestCount', 'cacheReportedRequestCount', ...TOKEN_FIELDS] as const) target[field] = count(target[field] + value[field]);
  for (const field of OPTIONAL_FIELDS) if (value[field] !== undefined) target[field] = count((target[field] ?? 0) + value[field]);
}

export class UsageStore {
  private records = new Map<string, StoredUsage>();
  private writes: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly onChange?: (scope: UsageScope) => void;

  constructor(directory: string, onChange?: (scope: UsageScope) => void) {
    this.file = path.join(directory, 'usage.json');
    this.onChange = onChange;
  }

  load(): Promise<void> {
    return this.enqueue(async () => {
      let content: string;
      try { content = await readFile(this.file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const stored: unknown = JSON.parse(content);
      if (!object(stored) || stored.version !== 1 || !Array.isArray(stored.entries)) throw new Error('用量文件格式无效。');
      const records = new Map<string, StoredUsage>();
      for (const entry of stored.entries) {
        if (!object(entry)) throw new Error('用量记录格式无效。');
        const scope = validateUsageScope(entry.scope);
        if (!scope || records.has(scopeKey(scope))) throw new Error('用量记录范围缺失或重复。');
        records.set(scopeKey(scope), { scope, summary: validateSummary(entry.summary) });
      }
      this.records = records;
    });
  }

  async record(report: UsageReport): Promise<void> {
    if (!object(report) || typeof report.model !== 'string' || !report.model.trim()) throw new Error('用量记录格式无效。');
    const scope = validateUsageScope(report.scope);
    if (!scope) throw new Error('用量记录必须指定范围。');
    const usage = report.usage === undefined ? undefined : validateTokens(report.usage);
    const increment = emptySummary();
    increment.requestCount = 1;
    if (usage) {
      increment.reportedRequestCount = 1;
      for (const field of TOKEN_FIELDS) increment[field] = usage[field];
      if (usage.reasoningTokens !== undefined) increment.reasoningTokens = usage.reasoningTokens;
      // 仅完整的命中/未命中对进入缓存汇总，命中率始终对应同一已知请求子集。
      if (usage.cacheHitTokens !== undefined && usage.cacheMissTokens !== undefined) {
        increment.cacheReportedRequestCount = 1;
        increment.cacheHitTokens = usage.cacheHitTokens;
        increment.cacheMissTokens = usage.cacheMissTokens;
      }
    }
    return this.enqueue(async () => {
      const key = scopeKey(scope), summary = structuredClone(this.records.get(key)?.summary ?? emptySummary());
      addSummary(summary, increment);
      const next = new Map(this.records);
      next.set(key, { scope, summary });
      // 保存累计数字，不保留正文、API Key 或逐次请求；写盘失败不发布未落盘的计数。
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', JSON.stringify({ version: 1, entries: [...next.values()] }), 'utf8');
      await rename(this.file + '.tmp', this.file);
      this.records = next;
      this.onChange?.(structuredClone(scope));
    });
  }

  async query(input?: UsageScope): Promise<UsageSummary> {
    const scope = validateUsageScope(input);
    await this.writes;
    if (scope) return structuredClone(this.records.get(scopeKey(scope))?.summary ?? emptySummary());
    const summary = emptySummary();
    for (const entry of this.records.values()) addSummary(summary, entry.summary);
    return summary;
  }

  idle(): Promise<void> { return this.writes; }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.writes.then(work);
    // 失败由本次调用接收；后续查询仍可读取上一次成功保存的统计。
    this.writes = operation.catch(() => {});
    return operation;
  }
}
