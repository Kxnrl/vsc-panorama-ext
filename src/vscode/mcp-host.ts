import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { LOCALE } from './locale';
import { messagesFor } from '../core/i18n';
import { SERVER_NAME } from '../mcp/server';

const MSG = messagesFor(LOCALE);

export const DEFAULT_MCP_PORT = 4377;
const HEARTBEAT_MS = 10_000;
/** 连续失败这么多次才尝试重拉——单次网络抖动不该触发 respawn */
const RESPAWN_AFTER_FAILURES = 3;

export function mcpConfig() {
  const cfg = vscode.workspace.getConfiguration('panorama');
  return {
    enabled: cfg.get<boolean>('mcp.enabled', true),
    port: cfg.get<number>('mcp.port', DEFAULT_MCP_PORT),
  };
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * daemon 健康探测（评审 #10）。不能只看 res.ok：端口上可能是别的东西，
 * 更常见的是**上一个扩展版本留下的旧 daemon**——它活着、健康、但工具集
 * 已过期；宿主会一边心跳给它续命，一边向客户端宣传新版本号。所以必须
 * 校验应答体里的 server 与 version，与当前扩展一致才算「当前」。
 */
async function daemonHealth(port: number): Promise<{ ok: boolean; server?: string; version?: string } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as { ok: boolean; server?: string; version?: string };
  } catch {
    return undefined;
  }
}

function expectedVersion(context: vscode.ExtensionContext): string | undefined {
  return context.extension?.packageJSON?.version as string | undefined;
}

/** 端口上的 daemon 是否就是「本版本扩展该有的那个」 */
async function isDaemonCurrent(context: vscode.ExtensionContext, port: number): Promise<boolean> {
  const h = await daemonHealth(port);
  if (!h?.ok || h.server !== SERVER_NAME) return false;
  const want = expectedVersion(context);
  // 拿不到期望版本（单测的极简 context）时只校验身份，不校验版本
  return want === undefined || h.version === want;
}

/**
 * 心跳升级为注册载体：一次 POST /register 同时完成活跃刷新、版本校验与
 * workspace roots 上报（daemon 侧据此维护 `workspaces` 工具的注册表）。
 * roots 在每次心跳时重读——窗口中途添加/移除文件夹不需要重新 wire。
 */
async function registerRoots(
  context: vscode.ExtensionContext,
  port: number,
): Promise<{ ok: boolean; server?: string; version?: string } | undefined> {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as { ok: boolean; server?: string; version?: string };
  } catch {
    return undefined;
  }
}

/** 注册应答是否同时满足「活着」与「是本版本」 */
function registerLooksCurrent(
  context: vscode.ExtensionContext,
  h: { ok: boolean; server?: string; version?: string } | undefined,
): boolean {
  if (!h?.ok || h.server !== SERVER_NAME) return false;
  const want = expectedVersion(context);
  return want === undefined || h.version === want;
}

/**
 * 把 MCP daemon 拉起来（若已在服务则什么都不做）。
 *
 * spawn 的三个细节，各有来头：
 * - `process.execPath` + ELECTRON_RUN_AS_NODE：扩展宿主进程是 Electron 二进制，
 *   不是 node；带上这个环境变量它就按纯 node 跑脚本，扩展内嵌工具的标准姿势；
 * - detached + stdio ignore + unref：daemon 的生命周期由心跳 TTL 自治
 *   （见 src/mcp/daemon.ts 头注释），不随本窗口的重载/退出而死——别的窗口
 *   和外部客户端可能还在用它；
 * - 端口被占时 daemon 自己以 0 退出：多窗口同时 ensure 是幂等的，这里
 *   不需要做任何互斥。
 */
export async function ensureDaemon(context: vscode.ExtensionContext, port: number): Promise<void> {
  // 没有扩展安装位置就无从定位 daemon 产物——真实宿主不会走到这里，
  // 这道守卫主要拦的是单测的极简 context（避免真的去 spawn 进程）
  if (!context.extensionUri) return;
  if (await isDaemonCurrent(context, port)) return;

  // 端口上有响应但不是当前版本（旧扩展留下的）→ 请它受控退出再拉新的。
  // 不杀就永远是旧工具集：心跳会一直误判它「健康」
  if (await daemonHealth(port)) {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
  }

  const daemonPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-daemon.cjs').fsPath;

  // contentRoots 以第一个工作区文件夹为基准绝对化：daemon 看不到 vscode 的
  // 相对路径语义，而配置里允许写相对 globs 一样的相对路径
  const roots = vscode.workspace
    .getConfiguration('panorama')
    .get<string[]>('contentRoots', [])
    .map((r) => {
      if (r.startsWith('/')) return r;
      const folder = vscode.workspace.workspaceFolders?.[0];
      return folder ? vscode.Uri.joinPath(folder.uri, r).fsPath : r;
    });

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PANORAMA_MCP_PORT: String(port),
      PANORAMA_MCP_LOCALE: LOCALE,
      ...(roots.length > 0 ? { PANORAMA_MCP_ROOTS: roots.join(',') } : {}),
    },
  });
  child.unref();

  // 等它把端口听上。600ms x 5 次覆盖冷启动；起不来也不抛——心跳循环会重试
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 600));
    if (await isDaemonCurrent(context, port)) return;
  }
}

/**
 * MCP 宿主：daemon 保活 + 状态栏 + VS Code 原生 provider + enable 命令。
 *
 * 返回的 Disposable 只清理**本窗口**的东西（定时器/状态栏/provider），
 * 刻意不杀 daemon：它是跨窗口共享的单例，退出条件只有心跳 TTL 到期。
 */
export function createMcpHost(context: vscode.ExtensionContext): { dispose(): void } {
  const disposables: { dispose(): void }[] = [];
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.name = 'CS2 Panorama MCP';
  status.command = 'panorama.mcp.enable';

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let failures = 0;

  const wire = (): void => {
    const { enabled, port } = mcpConfig();
    clearInterval(heartbeat);

    if (!enabled) {
      status.hide();
      status.tooltip = MSG.mcp.hostDisabled();
      return;
    }

    const url = mcpUrl(port);
    status.text = `$(plug) Panorama :${port}`;
    status.tooltip = MSG.mcp.hostStatusTooltip(url);
    status.show();

    void ensureDaemon(context, port);
    failures = 0;
    heartbeat = setInterval(() => {
      void registerRoots(context, port).then((h) => {
        const up = registerLooksCurrent(context, h);
        failures = up ? 0 : failures + 1;
        if (failures >= RESPAWN_AFTER_FAILURES) {
          failures = 0;
          void ensureDaemon(context, port);
        }
      });
    }, HEARTBEAT_MS);
    // 测试环境里没人 dispose 这个宿主，unref 别让 10s 定时器拖住进程退出
    (heartbeat as unknown as { unref?: () => void }).unref?.();
  };

  wire();
  disposables.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('panorama.mcp')) wire();
    }),
  );

  // VS Code 原生通道：把 daemon 注册给编辑器自己的 agent。两个通道同源
  // （都打到同一个 daemon），不存在「Copilot 看到的和 Claude Code 看到的
  // 不一样」。version 挂扩展版本，升级后编辑器会提示刷新工具列表。
  // provider 被查询时 daemon 可能还没起——ensure 是幂等的，就在这里补。
  const provider: vscode.McpServerDefinitionProvider = {
    async provideMcpServerDefinitions() {
      const { enabled, port } = mcpConfig();
      if (!enabled) return [];
      await ensureDaemon(context, port);
      return [
        new vscode.McpHttpServerDefinition('CS2 Panorama', vscode.Uri.parse(mcpUrl(port)), undefined, context.extension.packageJSON.version),
      ];
    },
  };
  disposables.push(vscode.lm.registerMcpServerDefinitionProvider('panorama.mcp', provider));

  disposables.push(
    vscode.commands.registerCommand('panorama.mcp.enable', () => runEnableCommand(context)),
  );

  return {
    dispose() {
      clearInterval(heartbeat);
      for (const d of disposables) d.dispose();
    },
  };
}

interface ClientTarget {
  /** 配置文件相对工作区根的路径；null 表示只复制不写文件 */
  readonly file: string | null;
  /** 顶层键：Claude Code / Cursor 用 mcpServers，VS Code 用 servers */
  readonly key: 'mcpServers' | 'servers';
  /** 条目体：三家都是 {type?,url} 的形状，Cursor 不带 type */
  readonly entry: (url: string) => Record<string, unknown>;
}

async function runEnableCommand(context: vscode.ExtensionContext): Promise<void> {
  const { enabled, port } = mcpConfig();
  if (!enabled) {
    void vscode.window.showInformationMessage(MSG.mcp.hostDisabled());
    return;
  }
  await ensureDaemon(context, port);
  const url = mcpUrl(port);

  const targets: Record<'claudeCode' | 'vscode' | 'cursor' | 'claudeDesktop' | 'copyUrl', ClientTarget> = {
    claudeCode: { file: '.mcp.json', key: 'mcpServers', entry: (u) => ({ type: 'http', url: u }) },
    vscode: { file: '.vscode/mcp.json', key: 'servers', entry: (u) => ({ type: 'http', url: u }) },
    cursor: { file: '.cursor/mcp.json', key: 'mcpServers', entry: (u) => ({ url: u }) },
    claudeDesktop: { file: null, key: 'mcpServers', entry: (u) => ({ type: 'http', url: u }) },
    copyUrl: { file: null, key: 'mcpServers', entry: (u) => ({ url: u }) },
  };

  const pick = await vscode.window.showQuickPick(
    [
      { id: 'claudeCode', label: MSG.mcp.hostPickClaudeCode() },
      { id: 'vscode', label: MSG.mcp.hostPickVSCode() },
      { id: 'cursor', label: MSG.mcp.hostPickCursor() },
      { id: 'claudeDesktop', label: MSG.mcp.hostPickClaudeDesktop() },
      { id: 'copyUrl', label: MSG.mcp.hostPickCopyUrl() },
    ],
    { placeHolder: MSG.mcp.hostPickTitle() },
  );
  if (!pick) return;
  const target = targets[pick.id as keyof typeof targets];

  if (target.file === null) {
    // Claude Desktop 的配置文件位置随平台变，写不准就只给片段；
    // copyUrl 则只给 URL 本身
    const snippet =
      pick.id === 'copyUrl'
        ? url
        : JSON.stringify({ mcpServers: { 'cs2-panorama': target.entry(url) } }, null, 2);
    await vscode.env.clipboard.writeText(snippet);
    void vscode.window.showInformationMessage(MSG.mcp.hostCopied());
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const fileUri = vscode.Uri.joinPath(folder.uri, target.file);

  // writeFile 不建父目录（评审 #11）：全新工作区里 .vscode/、.cursor/
  // 都可能不存在，先补目录再写
  const dir = target.file.slice(0, target.file.lastIndexOf('/'));
  if (dir) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, dir));
  }

  let doc: { [k: string]: unknown } = {};
  try {
    const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
    doc = raw.trim().length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'FileNotFound') {
      // 文件在但 JSON 坏了：**绝不覆盖**用户的既有配置——这是这个命令唯一
      // 能造成破坏的地方，宁可让用户手动合并
      void vscode.window.showWarningMessage(MSG.mcp.hostConfigUnparsable(target.file));
      return;
    }
  }

  const bucket = (doc[target.key] ?? {}) as Record<string, unknown>;
  bucket['cs2-panorama'] = target.entry(url);
  doc[target.key] = bucket;

  await vscode.workspace.fs.writeFile(
    fileUri,
    new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`),
  );
  void vscode.window.showInformationMessage(MSG.mcp.hostWroteFile(target.file));
  void vscode.window.showTextDocument(fileUri);
}
