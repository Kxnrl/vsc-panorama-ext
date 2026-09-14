import { parseVxml } from '../../core/vxml/parser';
import { parseVcss } from '../../core/vcss/parser';
import { symbolsOfVxml, symbolsOfVcss } from '../../core/index/symbols';
import { WorkspaceIndex } from '../../core/index/workspace-index';
import { isIndexCandidate } from '../../core/index/discovery';
import { lineColAt } from '../position';
import type { McpEnv } from '../env';

/**
 * 混合仓库与超大树的保护闸：超过这个数还没扫完，多半是 root 给错了
 * （比如给了 / 或用户主目录）。截断并如实上报，而不是扫十分钟。
 */
const MAX_FILES = 5000;

/** 缓存有效期。编辑中的文件以磁盘为准（本工具读的就是磁盘），短 TTL 只为
 *  摊薄重复扫描；agent 需要最新状态时传 refresh。 */
const TTL_MS = 15_000;

interface ScanEntry {
  readonly index: WorkspaceIndex;
  /** uri -> 原文。行号换算需要原文；mod 仓库量级下全部驻留可接受 */
  readonly texts: ReadonlyMap<string, string>;
  readonly scannedAt: number;
  readonly files: number;
  readonly truncated: boolean;
  /** root 本身就是 panorama 内容目录（直接含 layout/ + styles/）的形态 */
  readonly contentDirRoot: boolean;
}

export class WorkspaceScanner {
  private readonly cache = new Map<string, ScanEntry>();

  constructor(private readonly env: McpEnv) {}

  /**
   * 取某个根的索引（带 TTL 缓存）。
   *
   * root 是「panorama 段祖先」形态时用 isIndexCandidate 过滤；root 本身就是
   * 内容目录（workspace 根 = panorama 目录，路径段里没有 panorama）时放宽为
   * 「layout/ 或 styles/ 之下 + 后缀正确」——与 vscode 侧 findFiles 从工作区
   * 根出发的视野一致，否则那种形态在这里会扫出 0 个文件。
   */
  indexFor(root: string, refresh = false): WorkspaceIndex {
    return this.scan(root, refresh).index;
  }

  scan(root: string, refresh = false): ScanEntry {
    const key = root.replace(/\\/g, '/');
    const hit = this.cache.get(key);
    if (!refresh && hit && Date.now() - hit.scannedAt < TTL_MS) return hit;

    const contentDirRoot =
      this.env.fs.exists(`${key}/layout`) && this.env.fs.exists(`${key}/styles`);

    const index = new WorkspaceIndex({
      exists: (p) => this.env.fs.exists(p),
      ...(this.env.contentRoots ? { contentRoots: this.env.contentRoots } : {}),
    });
    const texts = new Map<string, string>();

    let files = 0;
    let truncated = false;
    for (const p of this.env.fs.listFiles(key)) {
      if (files >= MAX_FILES) {
        truncated = true;
        break;
      }
      const candidate = contentDirRoot ? indexShapedPath(p) : isIndexCandidate(p);
      if (!candidate) continue;
      let text: string;
      try {
        text = this.env.fs.readFile(p);
      } catch {
        continue; // 读不到就当不存在——与 vscode 侧 ingest 的容错同型
      }
      texts.set(p, text);
      index.update(p.endsWith('.css') || p.endsWith('.vcss')
        ? symbolsOfVcss(p, parseVcss(text))
        : symbolsOfVxml(p, parseVxml(text)));
      files++;
    }

    const entry: ScanEntry = { index, texts, scannedAt: Date.now(), files, truncated, contentDirRoot };
    this.cache.set(key, entry);
    return entry;
  }

  /** 符号定位 -> 行列输出（需要原文，见 {@link ScanEntry.texts}） */
  locate(entry: ScanEntry, loc: { uri: string; start: number }): { path: string; line: number; column: number } | undefined {
    const text = entry.texts.get(loc.uri);
    if (text === undefined) return undefined;
    const at = lineColAt(text, loc.start);
    return { path: loc.uri, line: at.line, column: at.column };
  }

  /** root 合法性判断走 env 谓词，不在这里再开一条 fs 通道 */
  isDir(path: string): boolean {
    return this.env.fs.isDirectory(path);
  }
}

/**
 * 路径是否「layout/ 或 styles/ 段之下 **且** 后缀配对」（段判定；不查 panorama 段）。
 * contentDir 模式专用：不查后缀的旧版把 styles/readme.txt 也收进来、
 * 还按 VXML 解析——垃圾符号进了索引、scannedFiles 虚增。与 isIndexCandidate
 * 的差别只有「不要求 panorama 段」（root 本身就是内容目录的形态）。
 */
function indexShapedPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/');
  const file = segments.pop();
  if (!file) return false;
  const underLayout = segments.includes('layout');
  const underStyles = segments.includes('styles');
  return (
    (underLayout && (file.endsWith('.xml') || file.endsWith('.vxml'))) ||
    (underStyles && (file.endsWith('.css') || file.endsWith('.vcss')))
  );
}

export type SymbolKind = 'class' | 'id' | 'define' | 'keyframe';

export interface SymbolsInput {
  readonly root: string;
  readonly kind: SymbolKind;
  /** 不给 name：列出该类别的全部名字 */
  readonly name?: string;
  readonly refresh?: boolean;
}

export interface LocatedSymbol {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface SymbolsOk {
  readonly ok: true;
  readonly root: string;
  readonly kind: SymbolKind;
  readonly name?: string;
  readonly scannedFiles: number;
  readonly truncated: boolean;
  /** name 省略时的全名录 */
  readonly names?: readonly string[];
  readonly definitions?: readonly LocatedSymbol[];
  readonly references?: readonly LocatedSymbol[];
}

export interface SymbolsErr {
  readonly ok: false;
  readonly error: 'root-not-dir';
  readonly message: string;
}

export type SymbolsResult = SymbolsOk | SymbolsErr;

export function querySymbols(
  input: SymbolsInput,
  scanner: WorkspaceScanner,
  errRootNotDir: (root: string) => string,
): SymbolsResult {
  const root = input.root.replace(/\\/g, '/');
  if (!scanner.isDir(root)) {
    return { ok: false, error: 'root-not-dir', message: errRootNotDir(root) };
  }

  const entry = scanner.scan(root, input.refresh === true);
  const index = entry.index;

  const namesOf = (): readonly string[] =>
    input.kind === 'class'
      ? index.allClassNames()
      : input.kind === 'id'
        ? index.allIdNames()
        : input.kind === 'define'
          ? index.allDefineNames()
          : index.allKeyframeNames();

  if (input.name === undefined) {
    return {
      ok: true,
      root,
      kind: input.kind,
      scannedFiles: entry.files,
      truncated: entry.truncated,
      names: namesOf(),
    };
  }

  // 守卫之后取值，让 name 拿到收窄后的 string 类型——否则下面 8 个调用点
  // 全是 string | undefined
  const name = input.name;

  const defsOf = (): readonly { uri: string; start: number }[] =>
    input.kind === 'class'
      ? index.classDefinitions(name)
      : input.kind === 'id'
        ? index.idDefinitions(name)
        : input.kind === 'define'
          ? index.defineDefinitions(name)
          : index.keyframeDefinitions(name);
  const refsOf = (): readonly { uri: string; start: number }[] =>
    input.kind === 'class'
      ? index.classReferences(name)
      : input.kind === 'id'
        ? index.idReferences(name)
        : input.kind === 'define'
          ? index.defineReferences(name)
          : index.keyframeReferences(name);

  return {
    ok: true,
    root,
    kind: input.kind,
    name: input.name,
    scannedFiles: entry.files,
    truncated: entry.truncated,
    definitions: defsOf()
      .map((l) => scanner.locate(entry, l))
      .filter((x): x is LocatedSymbol => x !== undefined),
    references: refsOf()
      .map((l) => scanner.locate(entry, l))
      .filter((x): x is LocatedSymbol => x !== undefined),
  };
}
