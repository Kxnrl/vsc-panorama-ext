import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 真子进程 HTTP 层：真 node 进程、真端口、真 Streamable HTTP 帧。
 * 进程内集成测试（server.test.ts）盖不住的三样东西只有这层能盖住：
 * esbuild 产物真的能跑、HTTP 路由真的对（405/404/健康检查）、
 * stdout 的端口上报（PANORAMA_MCP_PORT=0 时报实际端口）真的兑现。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

let child: ChildProcess | undefined;
let port = 0;

beforeAll(async () => {
  // 产物先重建：这层测试的对象是「构建结果」，不是「源码」
  execFileSync('node', ['esbuild.mjs'], { cwd: ROOT, stdio: 'pipe' });

  child = spawn('node', ['dist/mcp-daemon.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PANORAMA_MCP_PORT: '0', PANORAMA_MCP_LOCALE: 'zh-cn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // daemon 就绪信号就是 stdout 那行 JSON——不用猜启动耗时
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon 15s 未上报端口')), 15_000);
    let buf = '';
    child!.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      const line = buf.split('\n').find((l) => l.includes('"panoramaMcp"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line).port as number);
      }
    });
    child!.on('exit', (code) => reject(new Error(`daemon 提前退出：${code}`)));
  });
  port = await ready;
}, 30_000);

afterAll(() => {
  child?.kill('SIGTERM');
});

const BASE = () => `http://127.0.0.1:${port}`;

/** Streamable HTTP 的应答是 SSE 帧（event: message / data: {...}），抽出 data 行 */
async function rpc(method: string, params?: unknown, id = 1): Promise<unknown> {
  const res = await fetch(`${BASE()}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  const data = body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .join('');
  return JSON.parse(data).result;
}

describe('daemon · HTTP 层', () => {
  it('健康检查 200 且自报身份', async () => {
    const res = await fetch(`${BASE()}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; server: string; locale: string };
    expect(body.ok).toBe(true);
    expect(body.server).toBe('cs2-panorama');
    expect(body.locale).toBe('zh-cn');
  });

  it('PANORAMA_MCP_PORT=0 时上报实际端口（本次就已在用）', () => {
    expect(port).toBeGreaterThan(0);
  });

  it('initialize + tools/list 走通 streamable HTTP', async () => {
    const init = (await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '0' },
    })) as { serverInfo: { name: string } };
    expect(init.serverInfo.name).toBe('cs2-panorama');

    const tools = (await rpc('tools/list', {}, 2)) as {
      tools: { name: string }[];
    };
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'apply_fixes',
      'panel_info',
      'property_info',
      'symbols',
      'validate',
      'workspaces',
    ]);
  });

  it('validate 打真实文件：custom_game 违规 + 中文文案', async () => {
    const layout = join(ROOT, 'examples/panorama/layout/custom_game/demo/diagnostics-demo.xml');
    const res = (await rpc(
      'tools/call',
      { name: 'validate', arguments: { path: layout } },
      3,
    )) as { content: { text: string }[] };
    const parsed = JSON.parse(res.content[0].text) as {
      mode: string;
      diagnostics: { ruleId: string; message: string }[];
    };
    expect(parsed.mode).toBe('customHudLayout');
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    // locale 跟随 spawn 参数——这里应产中文
    expect(parsed.diagnostics.some((d) => /[一-鿿]/.test(d.message))).toBe(true);
  });

  it('GET /mcp 按规范答 405，未知路径答 404', async () => {
    const get = await fetch(`${BASE()}/mcp`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const missing = await fetch(`${BASE()}/nope`);
    expect(missing.status).toBe(404);
  });

  it('坏 JSON 答 -32700 而不是连坐整个进程', async () => {
    const res = await fetch(`${BASE()}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('/register 注册工作区 → workspaces 工具可发现；伪造 Host 被拒', async () => {
    const reg = await fetch(`${BASE()}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: ['/w/alpha', '/w/beta'] }),
    });
    expect(reg.status).toBe(200);
    expect((await reg.json()) as object).toMatchObject({ ok: true, registered: 2 });

    const ws = (await rpc('tools/call', { name: 'workspaces', arguments: {} }, 9)) as {
      content: { text: string }[];
    };
    const parsed = JSON.parse(ws.content[0].text) as { count: number; workspaces: { root: string }[] };
    expect(parsed.count).toBe(2);
    expect(parsed.workspaces.map((w) => w.root)).toEqual(['/w/alpha', '/w/beta']);

    const { request } = await import('node:http');
    const forged = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/register', method: 'POST', headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end('{"roots":["/evil"]}');
    });
    expect(forged).toBe(403);
  });

  it('apply_fixes 真落盘：临时文件修复后可从磁盘读回', async () => {
    const { writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const tmp = join(ROOT, '.tmp-apply-fixes.css');
    writeFileSync(tmp, '.x {\n  visibility: hidden;\n}\n@keyframes pulse { from { opacity: 1; } }\n');

    try {
      const res = (await rpc('tools/call', { name: 'apply_fixes', arguments: { path: tmp } }, 4)) as {
        content: { text: string }[];
      };
      const parsed = JSON.parse(res.content[0].text) as {
        applied: { ruleId: string }[];
        remaining: unknown[];
      };
      expect(parsed.applied.map((a) => a.ruleId).sort()).toEqual([
        'vcss.keyframesUnquoted',
        'vcss.visibilityHidden',
      ]);
      expect(readFileSync(tmp, 'utf8')).toBe(
        '.x {\n  visibility: collapse;\n}\n@keyframes "pulse" { from { opacity: 1; } }\n',
      );
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('DNS rebinding 防护：伪造 Host 的请求被 403，且带 Origin 的一律拒绝（评审 #1）', async () => {
    const { request } = await import('node:http');
    // undici 的 fetch 会用 URL 覆盖 Host 头，伪造不出来；裸 http 才能如实
    // 模拟 rebinding 页面发出的请求（Host = 攻击者域名）
    const status = (path: string, headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path, method: 'POST', headers },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      });

    // 伪造 Host（rebind 页面的典型形态）
    expect(
      await status('/mcp', {
        'content-type': 'application/json',
        host: 'evil.example',
      }),
    ).toBe(403);

    // 合法 Host 但带 Origin（浏览器形态）——纵深一层，同样拒绝
    expect(
      await status('/mcp', {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      }),
    ).toBe(403);

    // 健康检查同样吃 Host 守卫
    expect(await status('/health', { host: 'evil.example' })).toBe(403);
  });

  // 受控关停必须放在最后：它结束 daemon 进程
  it('/shutdown 让 daemon 受控退出（评审 #10 的替换通道）', async () => {
    const res = await fetch(`${BASE()}/shutdown`, { method: 'POST' });
    expect(res.status).toBe(200);

    // 进程退出、端口让出：健康探测随後失败
    const deadline = Date.now() + 5000;
    let gone = false;
    while (Date.now() < deadline && !gone) {
      try {
        await fetch(`${BASE()}/health`, { signal: AbortSignal.timeout(500) });
      } catch {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(gone, 'shutdown 后 5s 内端口应释放').toBe(true);

    const exited = new Promise<number>((resolve) => child!.on('exit', (c) => resolve(c ?? 0)));
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  });
});
