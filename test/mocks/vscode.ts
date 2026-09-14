/**
 * 最小 vscode 模块 mock。供适配层的注册逻辑测试，以及直接调用
 * provider 回调（provideCompletionItems / provideHover / provideDocumentSymbols）
 * 做行为级测试使用——registered 里保留 provider 本体，而不仅仅是注册记录，
 * 这样「忘了注册某个 provider」和「provider 接线后行为不对」两类错误都能被自动抓到。
 */
export interface Registration {
  readonly type: string;
  readonly language: string;
  readonly provider: unknown;
  /** register* 调用实际返回的那个 disposable——用于按身份核对它是否真的
   *  进了 context.subscriptions，而不是只数数量（数量对不出「漏一个、
   *  又刚好多一个」这种巧合）。 */
  readonly disposable: unknown;
  /** 仅补全注册有：真实 VSCode 里它决定「敲到什么字符会自动弹补全」 */
  readonly triggerCharacters?: readonly string[];
}

export const registered: Registration[] = [];

export function resetRegistrations(): void {
  registered.length = 0;
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class MarkdownString {
  constructor(public value = '') {}
  appendMarkdown(v: string): this {
    this.value += v;
    return this;
  }
}

export class Hover {
  constructor(public readonly contents: unknown) {}
}

export class CompletionItem {
  detail?: string;
  documentation?: unknown;
  sortText?: string;
  insertText?: string;
  // Task 9：适配层把 core 层的 replaceStart/replaceEnd 换算成 Range 挂在这里，
  // 供 provider 测试断言真实注册的回调是否把显式区间落到了返回值上。
  range?: Range;
  constructor(
    public readonly label: string,
    public readonly kind?: number,
  ) {}
}

export const CompletionItemKind = {
  Class: 6, Property: 9, Value: 11, Function: 2, Keyword: 13, Field: 4, Enum: 12,
} as const;

export const SymbolKind = { Namespace: 2, Class: 4, Property: 6, Variable: 12, Event: 23 } as const;

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(
    public readonly name: string,
    public readonly detail: string,
    public readonly kind: number,
    public readonly range: Range,
    public readonly selectionRange: Range,
  ) {
    // 真实 VSCode API 的硬约束：name 必须是非空字符串，否则
    // provideDocumentSymbols 在真实编辑器里会抛异常、拖垮整份大纲。
    // mock 补上这条校验，让测试以编辑器同样的方式失败（而不是静默放行）。
    if (!name) {
      throw new Error('DocumentSymbol#name 不能是空字符串（真实 VSCode API 会拒绝）');
    }
  }
}

export const languages = {
  registerCompletionItemProvider(
    selector: { language: string },
    provider: unknown,
    ...triggerCharacters: string[]
  ) {
    const disposable = { dispose() {} };
    // triggerCharacters 必须留存：真实 VSCode 里它决定「敲到什么字符会自动弹
    // 补全」。此前这里写成 `..._triggerCharacters` 直接丢弃，于是漏掉某个触发
    // 字符在测试里完全不可证伪——class= 里类名候选不自动弹，正是这么漏掉的。
    registered.push({
      type: 'completion',
      language: selector.language,
      provider,
      disposable,
      triggerCharacters,
    });
    return disposable;
  },
  registerHoverProvider(selector: { language: string }, provider: unknown) {
    const disposable = { dispose() {} };
    registered.push({ type: 'hover', language: selector.language, provider, disposable });
    return disposable;
  },
  registerDocumentSymbolProvider(selector: { language: string }, provider: unknown) {
    const disposable = { dispose() {} };
    registered.push({ type: 'symbol', language: selector.language, provider, disposable });
    return disposable;
  },
};

/**
 * `vscode.env.language` 决定扩展用哪套文案（src/vscode/locale.ts）。
 *
 * 这里固定 'zh-cn'，让适配层的既有断言（如 providers/vcss.test.ts 断言
 * detail 等于 '其它样式表的 @define'）保持中文、不必为本地化改写。
 *
 * **代价必须说清**：因此没有任何适配层单元测试会走英文路径。
 * `env.language -> localeOf -> messagesFor` 这条真实链路只有 E2E 验得了
 * （E2E 宿主的显示语言是英文），对应断言在 test/e2e/suite/extension.test.ts。
 * 别以为单元测试全绿就等于英文没问题——M4 的补全触发字符正是这么漏掉的。
 */
export const env = { language: 'zh-cn' };

export const workspace = {
  getConfiguration() {
    return { get: <T>(_key: string, fallback: T): T => fallback };
  },
};

/**
 * 最小 TextDocument 夹具：只实现适配层实际用到的四个成员。
 * 有意不去重建整个 VSCode TextDocument——够用就好。
 */
export interface MockTextDocument {
  getText(): string;
  offsetAt(position: Position): number;
  positionAt(offset: number): Position;
  readonly uri: { fsPath: string };
}

/** 供 provider 测试直接构造「文档 + 光标」，无需真实 VSCode 宿主 */
export function createDocument(text: string, fsPath = '/fake/test-file'): MockTextDocument {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }
  return {
    getText: () => text,
    uri: { fsPath },
    offsetAt(position: Position): number {
      const lineStart = lineStarts[position.line] ?? text.length;
      return lineStart + position.character;
    },
    positionAt(offset: number): Position {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
      return new Position(line, offset - lineStarts[line]);
    },
  };
}

// ---- 以下为 M3 索引宿主测试所需，追加，勿改动上方已有导出 ----

export class RelativePattern {
  constructor(
    public readonly base: unknown,
    public readonly pattern: string,
  ) {}
}

export class EventEmitter<T> {
  private handlers: Array<(e: T) => void> = [];
  event = (h: (e: T) => void) => {
    this.handlers.push(h);
    return { dispose: () => {} };
  };
  fire(e: T): void {
    for (const h of this.handlers) h(e);
  }
}

/** 测试可写入这两张表来模拟工作区内容 */
export const __workspaceFiles = new Map<string, string>();
export const __watchers: Array<{ pattern: unknown; onCreate: EventEmitter<Uri>; onChange: EventEmitter<Uri>; onDelete: EventEmitter<Uri> }> = [];

export class Uri {
  private constructor(public readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri(p);
  }
  toString(): string {
    return this.fsPath;
  }
}

Object.assign(workspace, {
  workspaceFolders: [{ uri: Uri.file('/w'), name: 'w', index: 0 }],
  async findFiles(_include: unknown, _exclude?: unknown): Promise<Uri[]> {
    return [...__workspaceFiles.keys()].map((p) => Uri.file(p));
  },
  createFileSystemWatcher(pattern: unknown) {
    const w = {
      pattern,
      onCreate: new EventEmitter<Uri>(),
      onChange: new EventEmitter<Uri>(),
      onDelete: new EventEmitter<Uri>(),
    };
    __watchers.push(w);
    return {
      onDidCreate: w.onCreate.event,
      onDidChange: w.onChange.event,
      onDidDelete: w.onDelete.event,
      dispose() {},
    };
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const text = __workspaceFiles.get(uri.fsPath);
      if (text === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
      return new TextEncoder().encode(text);
    },
    // enable 命令写 .vscode/mcp.json 前会先建父目录（评审 #11）
    async createDirectory(_uri: Uri): Promise<void> {},
    async stat(uri: Uri): Promise<{ type: number }> {
      const p = uri.fsPath;
      if (__workspaceFiles.has(p)) return { type: 1 };
      for (const f of __workspaceFiles.keys()) {
        if (f.startsWith(p.replace(/\/$/, '') + '/')) return { type: 2 };
      }
      throw new Error(`ENOENT: ${p}`);
    },
  },
  onDidChangeTextDocument() {
    return { dispose() {} };
  },
});

/**
 * 测试可写入这张表覆盖配置项。**键一律写全限定名**（`panorama.diagnostics.xxx`），
 * 与真实 VSCode 的语义一致：`getConfiguration(section).get(key)` 查的是 `section.key`。
 *
 * 这里原先写的是 ``const full = section ? `${key}` : key;``——模板串的两个分支
 * **完全相同**，`section` 被整个丢掉。后果是查找键的**前一半（节名）在测试里根本
 * 不可证伪**：把 `getConfiguration('panorama')` 改成 `getConfiguration('WRONG_SECTION')`
 * 后 714 条单元 + 13 条 E2E 全绿，而真实编辑器里七个诊断开关会被静默忽略
 * （Task 10 评审 I-1）。这是「**测试替身把参数丢了，于是一整条链路的一半自以为
 * 被守着**」这一形态——与断言写空/写偏不同，缺口在替身本身。
 *
 * 本文件此前的规矩是「只追加、勿改动上方已有导出」；这一处是修既有实现的缺陷，
 * 属于授权的例外，改动只会让判据变严（丢参数 -> 认参数），不会放松任何断言。
 */
export const __config = new Map<string, unknown>();

Object.assign(workspace, {
  getConfiguration(section?: string) {
    return {
      get: <T>(key: string, fallback: T): T => {
        const full = section ? `${section}.${key}` : key;
        return (__config.has(full) ? (__config.get(full) as T) : fallback);
      },
    };
  },
});

/**
 * 此前 onDidChangeTextDocument 的 mock 直接丢弃了传入的 handler，导致防抖
 * 重建符号这条路径在测试里完全触发不到——index-host.ts 里 drop() 忘记清理
 * 挂起定时器的 bug 正是因此才没被任何测试抓到。这里把 handler 存起来，
 * 测试可以通过 __docChangeHandlers 手动触发一次「文档变更」。
 */
export const __docChangeHandlers: Array<(e: unknown) => void> = [];

Object.assign(workspace, {
  onDidChangeTextDocument(h: (e: unknown) => void) {
    __docChangeHandlers.push(h);
    return { dispose() {} };
  },
});

// ---- 以下为 Task 7（跳转定义 / 查找引用）所需，追加，勿改动上方已有导出 ----

export class Location {
  constructor(
    public readonly uri: Uri,
    public readonly rangeOrPosition: Range | Position,
  ) {}
}

Object.assign(languages, {
  registerDefinitionProvider(selector: { language: string }, provider: unknown) {
    const disposable = { dispose() {} };
    registered.push({ type: 'definition', language: selector.language, provider, disposable });
    return disposable;
  },
  registerReferenceProvider(selector: { language: string }, provider: unknown) {
    const disposable = { dispose() {} };
    registered.push({ type: 'reference', language: selector.language, provider, disposable });
    return disposable;
  },
});

Object.assign(workspace, {
  async openTextDocument(uri: Uri) {
    const text = __workspaceFiles.get(uri.fsPath) ?? '';
    return {
      uri,
      getText: () => text,
      positionAt: (o: number) => new Position(0, o),
      offsetAt: (p: Position) => p.character,
    };
  },
});

// ---- 以下为 Task 8（颜色装饰器）所需，追加，勿改动上方已有导出 ----

export class Color {
  constructor(
    public readonly red: number,
    public readonly green: number,
    public readonly blue: number,
    public readonly alpha: number,
  ) {}
}
export class ColorInformation {
  constructor(
    public readonly range: Range,
    public readonly color: Color,
  ) {}
}
export class ColorPresentation {
  constructor(public readonly label: string) {}
}

Object.assign(languages, {
  registerColorProvider(selector: { language: string }, provider: unknown) {
    const disposable = { dispose() {} };
    registered.push({ type: 'color', language: selector.language, provider, disposable });
    return disposable;
  },
});

// ---- 以下为 M4 Task 10（诊断宿主）所需，追加，勿改动上方已有导出 ----

/** 与真实 vscode.DiagnosticSeverity 的数值逐个一致——Hint 是 3 不是 2 */
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

export class Diagnostic {
  source?: string;
  code?: string;
  constructor(
    public readonly range: Range,
    public readonly message: string,
    public readonly severity?: number,
  ) {}
}

/**
 * 最小 DiagnosticCollection。entries 按 uri 字符串存，测试直接读它断言
 * 「某个文件此刻挂着哪些诊断」——这正是「关掉的文件还挂着诊断」那个陷阱
 * 唯一能被观察到的地方。
 */
export class MockDiagnosticCollection {
  readonly entries = new Map<string, readonly unknown[]>();
  disposed = false;
  constructor(public readonly name: string) {}
  set(uri: Uri, diagnostics?: readonly unknown[]): void {
    // 真实 API 里 set(uri, undefined) 等价于清空该文件
    if (diagnostics === undefined) this.entries.delete(uri.toString());
    else this.entries.set(uri.toString(), diagnostics);
  }
  get(uri: Uri): readonly unknown[] | undefined {
    return this.entries.get(uri.toString());
  }
  delete(uri: Uri): void {
    this.entries.delete(uri.toString());
  }
  clear(): void {
    this.entries.clear();
  }
  dispose(): void {
    this.entries.clear();
    this.disposed = true;
  }
}

export const __diagnosticCollections: MockDiagnosticCollection[] = [];

Object.assign(languages, {
  createDiagnosticCollection(name: string) {
    const c = new MockDiagnosticCollection(name);
    __diagnosticCollections.push(c);
    return c;
  },
});

/**
 * 诊断宿主用得到的 TextDocument 面：比上面的 MockTextDocument 多 languageId
 * 与真实的 Uri（诊断集合按 uri 存）。
 */
export interface MockOpenDocument extends MockTextDocument {
  readonly languageId: string;
  readonly uri: Uri;
}

/** 当前「打开着」的文档集合；workspace.textDocuments 读的就是它 */
export const __openDocuments: MockOpenDocument[] = [];
export const __docOpenHandlers: Array<(doc: unknown) => void> = [];
export const __docCloseHandlers: Array<(doc: unknown) => void> = [];

Object.assign(workspace, {
  onDidOpenTextDocument(h: (doc: unknown) => void) {
    __docOpenHandlers.push(h);
    return { dispose() {} };
  },
  onDidCloseTextDocument(h: (doc: unknown) => void) {
    __docCloseHandlers.push(h);
    return { dispose() {} };
  },
});

Object.defineProperty(workspace, 'textDocuments', {
  configurable: true,
  get: () => __openDocuments,
});

export function createOpenDocument(
  text: string,
  fsPath: string,
  languageId: string,
): MockOpenDocument {
  const base = createDocument(text, fsPath);
  return {
    getText: base.getText,
    offsetAt: base.offsetAt,
    positionAt: base.positionAt,
    uri: Uri.file(fsPath),
    languageId,
  };
}

/** 打开一份文档：进 textDocuments，并触发真实注册的 onDidOpenTextDocument 回调 */
export function fireDocOpen(doc: MockOpenDocument): void {
  __openDocuments.push(doc);
  for (const h of [...__docOpenHandlers]) h(doc);
}

/** 关闭一份文档：出 textDocuments，并触发真实注册的 onDidCloseTextDocument 回调 */
export function fireDocClose(doc: MockOpenDocument): void {
  const i = __openDocuments.indexOf(doc);
  if (i >= 0) __openDocuments.splice(i, 1);
  for (const h of [...__docCloseHandlers]) h(doc);
}

/** 编辑一份已打开的文档：触发真实注册的 onDidChangeTextDocument 回调 */
export function fireDocEdit(doc: MockOpenDocument): void {
  for (const h of [...__docChangeHandlers]) h({ document: doc });
}

// ---- 以下为 M4 Task 10 收口轮（配置变化重算）所需，追加，勿改动上方已有导出 ----

export const __configChangeHandlers: Array<(e: unknown) => void> = [];

Object.assign(workspace, {
  onDidChangeConfiguration(h: (e: unknown) => void) {
    __configChangeHandlers.push(h);
    return { dispose() {} };
  },
});

/**
 * 触发一次配置变化。`changed` 是本次真正变了的**全限定**节名（例如
 * `panorama.diagnostics.unknownClass`）。事件对象的 affectsConfiguration(s) 与真实
 * VSCode 同义：被查询的 `s` 是某个变更节名本身、或是它的前缀段时算「受影响」。
 * 刻意不做成「永远返回 true」——那样监听器里那句 affectsConfiguration 判断就又
 * 成了不可证伪的一半，正是 I-1 那个形态。
 */
export function fireConfigChange(changed: readonly string[]): void {
  const e = {
    affectsConfiguration(section: string): boolean {
      return changed.some((c) => c === section || c.startsWith(section + '.'));
    },
  };
  for (const h of [...__configChangeHandlers]) h(e);
}

// ---- 以下为 MCP 宿主（src/vscode/mcp-host.ts）所需，追加，勿改动上方已有导出 ----

export const __statusBarItems: Array<{
  name: string;
  text: string;
  tooltip: unknown;
  command: string;
  shown: number;
  hidden: number;
  dispose(): void;
}> = [];

export const __commands: Array<{ id: string; handler: unknown }> = [];

/** registerMcpServerDefinitionProvider 注册进来的 provider 本体，供行为级断言 */
export const __mcpProviders: Array<{ id: string; provider: unknown }> = [];

export class McpHttpServerDefinition {
  constructor(
    public readonly label: string,
    public uri: unknown,
    public headers: Record<string, string> = {},
    public version?: string,
  ) {}
}

export const lm = {
  registerMcpServerDefinitionProvider(id: string, provider: unknown) {
    const disposable = { dispose() {} };
    __mcpProviders.push({ id, provider });
    return disposable;
  },
};

Object.assign(Uri, {
  joinPath(base: Uri, ...parts: string[]): Uri {
    return Uri.file([base.fsPath.replace(/\/+$/, ''), ...parts].join('/'));
  },
  parse(s: string): Uri {
    // MCP 宿主只 parse http URL；mock 里保底还原成可比较的字符串形态
    return Uri.file(s.replace(/^[a-z]+:\/\//, '/'));
  },
});

export const commands = {
  registerCommand(id: string, handler: unknown) {
    const disposable = { dispose() {} };
    __commands.push({ id, handler });
    return disposable;
  },
};

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export const window = {
  createStatusBarItem() {
    const item = {
      name: '',
      text: '',
      tooltip: '',
      command: '',
      shown: 0,
      hidden: 0,
      show() {
        this.shown++;
      },
      hide() {
        this.hidden++;
      },
      dispose() {},
    };
    __statusBarItems.push(item);
    return item;
  },
  async showQuickPick(): Promise<undefined> {
    return undefined;
  },
  async showInformationMessage(): Promise<undefined> {
    return undefined;
  },
  async showWarningMessage(): Promise<undefined> {
    return undefined;
  },
  async showTextDocument(): Promise<undefined> {
    return undefined;
  },
};

Object.assign(env, { clipboard: { async writeText(): Promise<void> {} } });

// ---- 以下为灯泡 quick fix（src/vscode/providers/code-actions.ts）所需，追加 ----

export const CodeActionKind = { QuickFix: { value: 'quickfix' } } as const;

export class CodeAction {
  edit?: unknown;
  diagnostics?: unknown[];
  isPreferred?: boolean;
  constructor(
    public readonly title: string,
    public readonly kind?: unknown,
  ) {}
}

/** 记录 replace 调用，供测试断言「灯泡里的编辑到底改哪段」 */
export class WorkspaceEdit {
  readonly replaces: Array<{ uri: unknown; range: Range; newText: string }> = [];
  replace(uri: unknown, range: Range, newText: string): void {
    this.replaces.push({ uri, range, newText });
  }
}

Object.assign(languages, {
  registerCodeActionsProvider(
    selector: { language: string },
    provider: unknown,
    _metadata?: unknown,
  ) {
    const disposable = { dispose() {} };
    registered.push({ type: 'codeaction', language: selector.language, provider, disposable });
    return disposable;
  },
});
