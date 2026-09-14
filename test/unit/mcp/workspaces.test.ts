import { describe, it, expect } from 'vitest';
import { WorkspaceRegistry } from '../../../src/mcp/tools/workspaces';

describe('WorkspaceRegistry', () => {
  it('注册两个 root、按序列出、反斜杠与尾斜杠归一', () => {
    const r = new WorkspaceRegistry();
    r.register(['/w/b', 'X:\\w\\a', '/w/c/'], 1000);
    // 默认字典序：'/'(0x2F) 排在 'X'(0x58) 前
    expect(r.list(1000)).toEqual([{ root: '/w/b' }, { root: '/w/c' }, { root: 'X:/w/a' }]);
  });

  it('超窗剔除：窗口关掉（或崩溃）后条目自动消失', async () => {
    const r = new WorkspaceRegistry(50);
    r.register(['/w/a'], Date.now());
    expect(r.list()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(r.list()).toEqual([]);
  });

  it('重复注册刷新 lastSeen，不产生重复条目', () => {
    const r = new WorkspaceRegistry(100);
    r.register(['/w/a'], 0);
    r.register(['/w/a'], 80); // 80ms 后再跳一次
    expect(r.list(90)).toEqual([{ root: '/w/a' }]); // 90-80=10，刷新后的条目仍在窗内
    expect(r.list(200)).toEqual([]); // 200-80=120 > ttl：未再心跳即剔除
  });

  it('空串与空数组安全', () => {
    const r = new WorkspaceRegistry();
    expect(r.register([''])).toBe(0);
    expect(r.list()).toEqual([]);
  });
});
