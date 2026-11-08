import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { PrivateSettings, PublicSettings, SettingsFields, SettingsPatch, PromptOverrides } from './contracts.js';
import { DEFAULT_PROMPTS, normalizePromptOverrides, resolvePrompts } from './prompts.js';
import { DEFAULT_ACTIVATION_SHORTCUT, normalizeShortcut } from './shortcut.js';

export const DEFAULT_SETTINGS: SettingsFields = {
  apiBaseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  reasoning: 'medium',
  maxToolRounds: 3,
  historyLimit: 10,
  petSize: 1,
  bodyColor: '#F58DAA',
  eyeColor: '#F90040',
  launchAtLogin: false,
  pauseOnFullscreen: true,
  followMouse: true,
  autoCopyScreenshots: true,
  activationShortcut: [...DEFAULT_ACTIVATION_SHORTCUT],
  prompts: { ...DEFAULT_PROMPTS },
};

interface StoredSettings extends Omit<SettingsFields, 'prompts'> {
  prompts?: PromptOverrides;
  encryptedApiKey?: string;
}

export function validateSettingsPatch(value: unknown): SettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效。');
  const input = value as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (input.activationShortcut !== undefined) patch.activationShortcut = normalizeShortcut(input.activationShortcut);
  if (input.prompts !== undefined) patch.prompts = normalizePromptOverrides(input.prompts);
  for (const key of ['launchAtLogin', 'pauseOnFullscreen', 'followMouse', 'autoCopyScreenshots'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new Error('开关设置无效。');
    patch[key] = input[key];
  }
  for (const key of ['bodyColor', 'eyeColor'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(input[key])) throw new Error('请选择有效的颜色。');
    patch[key] = input[key].toUpperCase();
  }
  if (input.petSize !== undefined) {
    if (typeof input.petSize !== 'number' || !Number.isFinite(input.petSize) || input.petSize < 0.6 || input.petSize > 1.6) throw new Error('宠物尺寸应在 0.6 到 1.6 之间。');
    patch.petSize = input.petSize;
  }
  if (input.reasoning !== undefined) {
    if (input.reasoning !== 'low' && input.reasoning !== 'medium' && input.reasoning !== 'high') throw new Error('思考强度无效。');
    patch.reasoning = input.reasoning;
  }
  if (input.maxToolRounds !== undefined) {
    if (typeof input.maxToolRounds !== 'number' || !Number.isSafeInteger(input.maxToolRounds) || input.maxToolRounds < 1) throw new Error('工具调用轮数上限应为正整数。');
    patch.maxToolRounds = input.maxToolRounds;
  }
  if (input.historyLimit !== undefined) {
    if (typeof input.historyLimit !== 'number' || !Number.isSafeInteger(input.historyLimit) || input.historyLimit < 1) throw new Error('历史记录保留条数应为正整数。');
    patch.historyLimit = input.historyLimit;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 128) throw new Error('模型名称无效。');
    patch.model = input.model.trim();
  }
  if (input.apiBaseUrl !== undefined) {
    if (typeof input.apiBaseUrl !== 'string') throw new Error('API 地址无效。');
    const address = new URL(input.apiBaseUrl);
    if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('API 地址应为 HTTP 或 HTTPS 服务地址。');
    patch.apiBaseUrl = address.toString().replace(/\/$/, '');
  }
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new Error('API Key 格式无效。');
    patch.apiKey = input.apiKey.trim();
  }
  return patch;
}

export class SettingsStore {
  private fields: SettingsFields = { ...DEFAULT_SETTINGS, activationShortcut: [...DEFAULT_ACTIVATION_SHORTCUT], prompts: { ...DEFAULT_PROMPTS } };
  private apiKey = '';
  private encryptedApiKey: string | undefined;
  private readonly file = path.join(app.getPath('userData'), 'settings.json');

  async load(): Promise<PublicSettings> {
    let content: string;
    try { content = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.getPublic();
      throw error;
    }
    const stored: unknown = JSON.parse(content);
    const patch = validateSettingsPatch(stored);
    const { apiKey: _discard, prompts, ...fields } = patch;
    this.fields = { ...DEFAULT_SETTINGS, ...fields, activationShortcut: [...(fields.activationShortcut ?? DEFAULT_ACTIVATION_SHORTCUT)], prompts: resolvePrompts(prompts) };
    const encrypted = (stored as Partial<StoredSettings>).encryptedApiKey;
    if (typeof encrypted === 'string' && encrypted) {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'));
      this.apiKey = decrypted.result;
      this.encryptedApiKey = encrypted;
    }
    return this.getPublic();
  }

  getPublic(): PublicSettings {
    return { ...this.fields, activationShortcut: [...this.fields.activationShortcut], prompts: { ...this.fields.prompts }, hasApiKey: this.apiKey.length > 0 };
  }

  getPrivate(): PrivateSettings {
    return { ...this.fields, activationShortcut: [...this.fields.activationShortcut], prompts: { ...this.fields.prompts }, apiKey: this.apiKey };
  }

  async save(value: unknown): Promise<PublicSettings> {
    const patch = validateSettingsPatch(value);
    const { apiKey, prompts, ...fields } = patch;
    const nextFields: SettingsFields = { ...this.fields, ...fields, prompts: prompts === undefined ? this.fields.prompts : resolvePrompts(prompts) };
    let encrypted = this.encryptedApiKey;
    if (apiKey !== undefined) {
      if (apiKey) {
        if (!await safeStorage.isAsyncEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储暂不可用，API Key 尚未保存。');
        encrypted = (await safeStorage.encryptStringAsync(apiKey)).toString('base64');
      } else encrypted = undefined;
    }
    const { prompts: effectivePrompts, ...storedFields } = nextFields;
    const overrides = normalizePromptOverrides(effectivePrompts);
    const stored: StoredSettings = { ...storedFields, ...(Object.keys(overrides).length ? { prompts: overrides } : {}), ...(encrypted ? { encryptedApiKey: encrypted } : {}) };
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', JSON.stringify(stored, null, 2), 'utf8');
    await rename(this.file + '.tmp', this.file);
    this.fields = nextFields;
    this.encryptedApiKey = encrypted;
    if (apiKey !== undefined) this.apiKey = apiKey;
    return this.getPublic();
  }
}
