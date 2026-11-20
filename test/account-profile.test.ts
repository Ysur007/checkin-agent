import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { extractFields } from '../src/plugins/jsonpath';

let repo: typeof import('../src/db/repo.js');
let db: typeof import('../src/db/index.js').db;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'checkin-profile-'));
  process.env.DATA_DIR = dir;
  const database = await import('../src/db/index.js');
  db = database.db;
  repo = await import('../src/db/repo.js');
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('account display name', () => {
  it('扩展新建的账号会被平台昵称改名', () => {
    const account = repo.createAccount({
      pluginId: 'modelscope',
      label: '魔搭 ModelScope 11-20 17:30',
      authSource: 'extension',
      labelSource: 'auto',
    });
    repo.applyAccountProfile(account.id, '阿柴');
    const after = repo.getAccount(account.id)!;
    expect(after.label).toBe('阿柴');
    expect(after.display_name).toBe('阿柴');
  });

  it('用户自己命名的账号只记录昵称，不改名', () => {
    const account = repo.createAccount({
      pluginId: 'modelscope',
      label: '主号',
      authSource: 'browser',
      labelSource: 'user',
    });
    repo.applyAccountProfile(account.id, '阿柴');
    const after = repo.getAccount(account.id)!;
    expect(after.label).toBe('主号');
    expect(after.display_name).toBe('阿柴');
  });

  it('同一平台昵称重复时追加序号', () => {
    const first = repo.createAccount({ pluginId: 'modelscope', label: 'x1', labelSource: 'auto' });
    repo.applyAccountProfile(first.id, '小号');
    const second = repo.createAccount({ pluginId: 'modelscope', label: 'x2', labelSource: 'auto' });
    repo.applyAccountProfile(second.id, '小号');
    expect(repo.getAccount(second.id)!.label).toBe('小号 #2');
  });

  it('空昵称不会覆盖已有名称', () => {
    const account = repo.createAccount({ pluginId: 'modelscope', label: 'keep-me', labelSource: 'auto' });
    repo.applyAccountProfile(account.id, '   ');
    expect(repo.getAccount(account.id)!.label).toBe('keep-me');
  });
});

describe('default naming', () => {
  it('同一平台重复用默认名时自动加序号', () => {
    const first = repo.createAccount({ pluginId: 'breezeblue', label: 'BreezeBlue', labelSource: 'auto' });
    expect(first.label).toBe('BreezeBlue');
    const next = repo.nextAccountLabel('breezeblue', 'BreezeBlue');
    expect(next).toBe('BreezeBlue #2');
    repo.createAccount({ pluginId: 'breezeblue', label: next, labelSource: 'auto' });
    expect(repo.nextAccountLabel('breezeblue', 'BreezeBlue')).toBe('BreezeBlue #3');
  });
});

describe('breezeblue profile extract', () => {
  it('从 /api/me 的常见字段里取昵称或邮箱前缀', () => {
    const adapter = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'plugins/breezeblue/adapter.json'), 'utf8'),
    ) as { profile: { extract: Record<string, string | string[]> } };

    expect(extractFields({ name: '小明' }, adapter.profile.extract).displayName).toBe('小明');
    expect(extractFields({ user: { name: '阿蓝' } }, adapter.profile.extract).displayName).toBe('阿蓝');
    expect(extractFields({ email: 'hi@example.com' }, adapter.profile.extract).email).toBe('hi@example.com');
  });
});

describe('modelscope profile extract', () => {
  it('从登录信息里取昵称，兼容大小写信封', () => {
    const adapter = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'plugins/modelscope/adapter.json'), 'utf8'),
    ) as { profile: { extract: Record<string, string | string[]> } };

    const upper = extractFields({ Success: true, Data: { NickName: '阿柴' } }, adapter.profile.extract);
    expect(upper.displayName).toBe('阿柴');

    const lower = extractFields({ success: true, data: { nickName: '柴柴' } }, adapter.profile.extract);
    expect(lower.displayName).toBe('柴柴');
  });
});
