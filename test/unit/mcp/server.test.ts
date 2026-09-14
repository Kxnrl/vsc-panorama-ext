import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../../src/mcp/server';
import { servicesFor, type McpEnv, type McpFs } from '../../../src/mcp/env';
import { WorkspaceScanner } from '../../../src/mcp/tools/symbols';

/**
 * 进程内集成测试：真实 Client <-> 真实 McpServer，只省掉网络。
 * 走 InMemoryTransport 而不是直接调工具函数，为的是把「schema 声明、
 * 注册、序列化」整条链路都过一遍——工具函数对、但 inputSchema 写错
 * （比如 required 漏了 path）只有这层抓得到。
 */

const LAYOUT = [
  '<root>',
  '  <styles><include src="s2r://panorama/styles/custom_game/hud.css" /></styles>',
  '  <Panel class="hud-root" id="root-panel">',
  '    <Button text="OK" />',
  '    <Label text="score" />',
  '  </Panel>',
  '</root>',
].join('\n');

const STYLES = [
  '.hud-root {',
  '  flow-children: right;',
  '  visibility: hidden;',
  '}',
  '.score { width: fill-parent-flow(1); }',
].join('\n');

const FILES = new Map<string, string>([
  ['/fake/repo/panorama/layout/custom_game/hud.xml', LAYOUT],
  ['/fake/repo/panorama/styles/custom_game/hud.css', STYLES],
  // 混合仓库噪音：不该被扫进索引
  ['/fake/repo/res/layout/main.xml', '<root />'],
  ['/fake/repo/src/styles/web.css', '.a { display: flex; }'],
  // contentDir 形态：root 本身就是内容目录（无 panorama 段）
  ['/fake/content/layout/hud2.xml', '<root><Panel class="cd-a" /></root>'],
  ['/fake/content/styles/hud2.css', '.cd-a { width: 10px; }'],
  // 后缀不配对的文件：contentDir 模式也不该收（评审 #8）
  ['/fake/content/styles/readme.txt', 'not a stylesheet'],
]);

beforeEach(() => {
  // apply_fixes 用例会改写 FILES；每轮恢复原始现场，避免用例间串味
  FILES.set('/fake/repo/panorama/layout/custom_game/hud.xml', LAYOUT);
  FILES.set('/fake/repo/panorama/styles/custom_game/hud.css', STYLES);
});

function fakeEnv(): McpEnv {
  const fs: McpFs = {
    readFile: (p) => {
      const t = FILES.get(p);
      if (t === undefined) throw new Error(`ENOENT: ${p}`);
      return t;
    },
    writeFile: (p, text) => FILES.set(p, text),
    // 目录可探测（真实 fs 语义）：目录本身不在文件表里，但它是若干文件的前缀
    exists: (p) =>
      FILES.has(p) || [...FILES.keys()].some((f) => f.startsWith(p.replace(/\/+$/, '') + '/')),
    isDirectory: (p) =>
      [...FILES.keys()].some((f) => f.startsWith(p.replace(/\/+$/, '') + '/')),
    listFiles: (root) => [...FILES.keys()].filter((f) => f.startsWith(root)),
  };
  return { fs, locale: 'en' };
}

let client: Client;

beforeEach(async () => {
  const env = fakeEnv();
  const server = buildMcpServer(env, servicesFor('en'), new WorkspaceScanner(env));
  client = new Client({ name: 'test', version: '0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
});

/** 工具返回的是 text 内容里的 JSON——daemon 对所有客户端的统一输出形态 */
async function callJson(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return JSON.parse(text);
}

describe('MCP server · 工具面板', () => {
  it('注册六个工具', async () => {
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name).sort()).toEqual([
      'apply_fixes',
      'panel_info',
      'property_info',
      'symbols',
      'validate',
      'workspaces',
    ]);
  });

  it('注册五个数据 resources 与三个 prompts', async () => {
    const res = await client.listResources();
    expect(res.resources.map((r) => r.uri).sort()).toEqual([
      'panorama://data/attribute-values',
      'panorama://data/observed-attributes',
      'panorama://data/observed-values',
      'panorama://data/panels',
      'panorama://data/properties',
    ]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      'review_file',
      'scaffold_layout',
      'web_to_panorama',
    ]);
  });
});

describe('MCP server · validate', () => {
  it('custom_game 布局：模式判定 + hud 规则 + 行列 + fix', async () => {
    const r = (await callJson('validate', {
      path: '/fake/repo/panorama/layout/custom_game/hud.xml',
    })) as {
      ok: boolean;
      mode: string;
      diagnostics: { ruleId: string; line: number; column: number; fix?: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('customHudLayout');
    const buttonText = r.diagnostics.find((d) => d.ruleId === 'hud.buttonText');
    expect(buttonText, 'Button text 违规要被报出来').toBeDefined();
    expect(buttonText!.line).toBe(4);
    expect(buttonText!.fix).toBeTruthy();
  });

  it('样式表：web-only 写法给出替代写法', async () => {
    const r = (await callJson('validate', {
      path: '/fake/repo/panorama/styles/custom_game/hud.css',
    })) as { diagnostics: { ruleId: string; line: number }[] };
    const hidden = r.diagnostics.find((d) => d.ruleId === 'vcss.visibilityHidden');
    expect(hidden, 'visibility: hidden 要被报出来').toBeDefined();
    expect(hidden!.line).toBe(3);
  });

  it('传 root 时跨文件规则在跑（类名可解析）', async () => {
    const r = (await callJson('validate', {
      path: '/fake/repo/panorama/layout/custom_game/hud.xml',
      root: '/fake/repo',
    })) as { crossFile: boolean; diagnostics: { ruleId: string }[] };
    expect(r.crossFile).toBe(true);
    // hud-root / score 都在 hud.css 里有定义，unknownClass 不该出现
    expect(r.diagnostics.some((d) => d.ruleId === 'vxml.unknownClass')).toBe(false);
  });

  it('不支持的路径与不存在的路径给出 ok:false 而不是抛异常', async () => {
    const bad = (await callJson('validate', { path: '/fake/x.txt' })) as { ok: boolean; error: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('unsupported-path');
    const missing = (await callJson('validate', { path: '/fake/nope.css' })) as {
      ok: boolean;
      error: string;
    };
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe('file-not-found');
  });
});

describe('MCP server · 参考查询', () => {
  it('panel_info：继承与声明者', async () => {
    const r = (await callJson('panel_info', { panel: 'Label' })) as {
      derivedFrom: string;
      attributes: { name: string; declaredBy: string }[];
    };
    expect(r.derivedFrom).toBe('Panel');
    expect(r.attributes.find((a) => a.name === 'text')!.declaredBy).toBe('Label');
    expect(r.attributes.find((a) => a.name === 'id')!.declaredBy).toBe('Panel');
  });

  it('panel_info：未知面板给出「数据不全」而不是断言不存在', async () => {
    const r = (await callJson('panel_info', { panel: 'NotAPanel' })) as {
      ok: boolean;
      note?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.note).toBeTruthy();
  });

  it('property_info：display 查出 web-only + 替代写法', async () => {
    const r = (await callJson('property_info', { name: 'display' })) as {
      lookup: { kind: string; replacement?: string };
    };
    expect(r.lookup.kind).toBe('web-only');
    expect(r.lookup.replacement).toBeTruthy();
  });

  it('property_info：flow-children 是 Panorama 属性', async () => {
    const r = (await callJson('property_info', { name: 'flow-children' })) as {
      lookup: { kind: string };
    };
    expect(r.lookup.kind).toBe('property');
  });
});

describe('MCP server · symbols', () => {
  it('列类名：只收 Panorama 文件，混合仓库噪音不进索引', async () => {
    const r = (await callJson('symbols', { root: '/fake/repo', kind: 'class' })) as {
      names?: string[];
      scannedFiles: number;
    };
    expect(r.names!.sort()).toEqual(['hud-root', 'score']);
    expect(r.scannedFiles).toBe(2);
  });

  it('按名查询给定义与引用的行列', async () => {
    const r = (await callJson('symbols', {
      root: '/fake/repo',
      kind: 'class',
      name: 'hud-root',
    })) as {
      definitions: { path: string; line: number }[];
      references: { path: string; line: number }[];
    };
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0].line).toBe(1); // .hud-root { 在第 1 行
    expect(r.references).toHaveLength(1);
    expect(r.references[0].line).toBe(3); // class="hud-root" 在第 3 行
  });

  it('root 不是目录时报错而不是崩', async () => {
    const r = (await callJson('symbols', { root: '/nope', kind: 'class' })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('root-not-dir');
  });

  it('contentDir 模式也做后缀配对：readme.txt 不进索引（评审 #8）', async () => {
    const r = (await callJson('symbols', { root: '/fake/content', kind: 'class' })) as {
      names?: string[];
      scannedFiles: number;
    };
    expect(r.names).toEqual(['cd-a']);
    // hud2.xml + hud2.css 各一，readme.txt 被后缀配对挡掉
    expect(r.scannedFiles).toBe(2);
  });
});

describe('MCP server · apply_fixes', () => {
  const LAYOUT_PATH = '/fake/repo/panorama/layout/custom_game/hud.xml';

  it('确定性修复落盘，remaining 清零（新类名即时被索引核验）', async () => {
    const r = (await callJson('apply_fixes', { path: LAYOUT_PATH })) as {
      ok: boolean;
      applied: { ruleId: string }[];
      remaining: { ruleId: string }[];
    };
    expect(r.ok).toBe(true);
    // 夹具里两处机械修复：Button text + 根面板 id（vxml.rootPanelId）
    expect(r.applied.map((a) => a.ruleId).sort()).toEqual(['hud.buttonText', 'vxml.rootPanelId']);
    // 合并出的新类名 root-panel 在工作区样式表里无定义 → 如实报一条 hint
    expect(r.remaining.map((x) => x.ruleId)).toEqual(['vxml.unknownClass']);

    const after = FILES.get(LAYOUT_PATH)!;
    expect(after).toContain('<Button><Label text="OK" /></Button>');
    // 根面板 id 按提示转成 class 并入既有值，名字不丢
    expect(after).toContain('<Panel class="hud-root root-panel">');
  });

  it('ruleIds 传空数组 = 一条都不修（与「没传」语义分开，评审 #7）', async () => {
    const r = (await callJson('apply_fixes', { path: LAYOUT_PATH, ruleIds: [] })) as {
      applied: unknown[];
      remaining: { ruleId: string }[];
    };
    expect(r.applied).toEqual([]);
    expect(FILES.get(LAYOUT_PATH)).toBe(LAYOUT); // 文件一字未动
    // remaining 仍是完整作业清单（两处可修问题都在）
    expect(r.remaining.map((x) => x.ruleId).sort()).toEqual(['hud.buttonText', 'vxml.rootPanelId']);
  });

  it('显式 root 不是目录：报 root-not-dir 而不是静默空索引（评审 #9）', async () => {
    const r = (await callJson('validate', {
      path: LAYOUT_PATH,
      root: '/typo/root',
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('root-not-dir');

    const f = (await callJson('apply_fixes', { path: LAYOUT_PATH, root: '/typo/root' })) as {
      ok: boolean;
      error: string;
    };
    expect(f.ok).toBe(false);
    expect(f.error).toBe('root-not-dir');
    expect(FILES.get(LAYOUT_PATH)).toBe(LAYOUT); // 也没动文件
  });

  it('dryRun 演算但不落盘', async () => {
    const r = (await callJson('apply_fixes', { path: LAYOUT_PATH, dryRun: true })) as {
      applied: { ruleId: string }[];
    };
    expect(r.applied.length).toBeGreaterThan(0);
    expect(FILES.get(LAYOUT_PATH)).toBe(LAYOUT); // 原文未动
  });

  it('ruleIds 过滤：只动指定的规则', async () => {
    const r = (await callJson('apply_fixes', {
      path: LAYOUT_PATH,
      ruleIds: ['hud.buttonText'],
    })) as { applied: { ruleId: string }[] };
    expect(r.applied.map((a) => a.ruleId)).toEqual(['hud.buttonText']);
    const after = FILES.get(LAYOUT_PATH)!;
    expect(after).toContain('<Button><Label text="OK" /></Button>');
    // rootPanelId 不在名单里：id 原样保留
    expect(after).toContain('id="root-panel"');
  });
});
