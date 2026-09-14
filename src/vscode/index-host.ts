import * as vscode from 'vscode';
import { parseVxml } from '../core/vxml/parser';
import { parseVcss } from '../core/vcss/parser';
import { symbolsOfVxml, symbolsOfVcss } from '../core/index/symbols';
import { WorkspaceIndex } from '../core/index/workspace-index';

import { INDEX_GLOBS as CORE_INDEX_GLOBS, isPanoramaContent as coreIsPanoramaContent } from '../core/index/discovery';

/**
 * 判据本体（INDEX_GLOBS / isPanoramaContent / 段判定 isIndexCandidate）已下沉到
 * core/index/discovery.ts——MCP daemon 与 vscode 适配层共用同一份，防止两条
 * 扫描链各自演化后「扩展里能查到的符号、daemon 里查不到」。这里 re-export
 * 保持既有导入路径（test/unit/vscode/index-host.test.ts）不变：搬定义不该让
 * 测试跟着改。
 */
export const INDEX_GLOBS = CORE_INDEX_GLOBS;

/** 同上：转发 core 的判据，注释见 core/index/discovery.ts。 */
export const isPanoramaContent = coreIsPanoramaContent;

const DEBOUNCE_MS = 300;

function isVxml(path: string): boolean {
  return path.endsWith('.xml') || path.endsWith('.vxml');
}

/** 同步存在性判断：s2r 解析要在补全的同步路径里用，不能等异步 stat */
function existsSync(path: string): boolean {
  // VSCode 没有同步 fs API。索引在扫描期已经知道工作区里有哪些文件，
  // 目录则由文件路径前缀推出——这对 s2r 的两类候选判断已经够用，
  // 且避免了在补全路径上做异步 IO。
  return knownPaths.has(path) || dirPrefixes.has(path);
}

const knownPaths = new Set<string>();
const dirPrefixes = new Set<string>();

function remember(path: string): void {
  knownPaths.add(path);
  let dir = path;
  for (;;) {
    const i = dir.lastIndexOf('/');
    if (i <= 0) break;
    dir = dir.slice(0, i);
    dirPrefixes.add(dir);
  }
}

function forget(path: string): void {
  knownPaths.delete(path);
  // 目录前缀不回收：一个空目录被误判为存在，最坏后果是多试一个候选根，
  // 而候选仍要通过文件存在性验证才会被采纳。
}

export function createIndexHost(context: vscode.ExtensionContext): WorkspaceIndex {
  const cfg = vscode.workspace.getConfiguration('panorama');
  const contentRoots = cfg.get<string[]>('contentRoots', []);
  const enabled = cfg.get<boolean>('index.enabled', true);
  const extraExclude = cfg.get<string[]>('index.exclude', []);

  const index = new WorkspaceIndex({ exists: existsSync, contentRoots });

  // 关闭索引后跨文件能力降级为单文件能力（规格 §12）：返回一个永远为空的
  // 索引，provider 照常调用，只是拿不到跨文件候选。比在每个 provider 里
  // 加分支干净。
  if (!enabled) return index;

  const exclude = ['**/node_modules/**', ...extraExclude].join(',');
  const excludeGlob = extraExclude.length > 0 ? `{${exclude}}` : '**/node_modules/**';

  // 编辑中的文档以内存内容为准，防抖后重建该文件的符号。声明提到 ingest/drop
  // 前面，因为 drop 也要能清掉该路径挂起的定时器（见下）。
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const ingest = async (uri: vscode.Uri): Promise<void> => {
    const path = uri.fsPath.replace(/\\/g, '/');
    // 后置过滤的唯一闸口：首次全量扫描与 watcher 的 create/change 都经由这里，
    // 两条路径因此共用同一个判定。把它放到扫描循环里而不是这里，watcher 就会把
    // 扫描时丢弃的文件重新塞回索引——那是 Task 4 那个「删除被防抖静默撤销」的
    // 同型陷阱，只是方向反过来。
    if (!isPanoramaContent(path)) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      remember(path);
      index.update(
        isVxml(path)
          ? symbolsOfVxml(path, parseVxml(text))
          : symbolsOfVcss(path, parseVcss(text)),
      );
    } catch {
      // 读不到就当它不存在——文件可能刚被删掉
      forget(path);
      index.remove(path);
    }
  };

  const drop = (uri: vscode.Uri): void => {
    const path = uri.fsPath.replace(/\\/g, '/');
    // 必须先清掉这个路径挂起的防抖定时器：否则文件删除后，此前一次编辑
    // 排的队仍会在 300ms 后触发，把刚删掉的文件重新 index.update() 回去，
    // 删除被静默撤销。
    clearTimeout(timers.get(path));
    timers.delete(path);
    forget(path);
    index.remove(path);
  };

  // 首次全量扫描：异步进行，provider 在此期间基于部分结果工作，不阻塞
  void (async () => {
    for (const glob of INDEX_GLOBS) {
      const found = await vscode.workspace.findFiles(glob, excludeGlob);
      for (const uri of found) await ingest(uri);
    }
  })();

  for (const glob of INDEX_GLOBS) {
    const watcher = vscode.workspace.createFileSystemWatcher(glob);
    watcher.onDidCreate(ingest);
    watcher.onDidChange(ingest);
    watcher.onDidDelete(drop);
    context.subscriptions.push(watcher);
  }

  // 编辑中文档这条路径**刻意不过 isPanoramaContent**：它的门槛是 languageId，
  // 而 languageId 本身已经是更强的信号——.vxml / .vcss 后缀无条件就是 Panorama
  // 文件，.xml / .css 则只有命中 package.json 里那两条 filenamePatterns
  // （都要求 panorama 段）才拿得到这个 languageId。所以混合仓库里的
  // res/layout/x.xml 根本走不到这里，这条路径不是后置过滤的后门；反过来真去
  // 过滤它，会把「用户正在编辑的、后缀就是 .vcss 的文件」挡在索引外，那是纯粹
  // 的功能倒退。
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const id = e.document.languageId;
      if (id !== 'panorama-vxml' && id !== 'panorama-vcss') return;
      const path = e.document.uri.fsPath.replace(/\\/g, '/');
      clearTimeout(timers.get(path));
      timers.set(
        path,
        setTimeout(() => {
          const text = e.document.getText();
          remember(path);
          index.update(
            id === 'panorama-vxml'
              ? symbolsOfVxml(path, parseVxml(text))
              : symbolsOfVcss(path, parseVcss(text)),
          );
        }, DEBOUNCE_MS),
      );
    }),
  );

  return index;
}
