import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** examples/ 是 E2E 的工作区根 */
function exampleUri(rel: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root, '未打开工作区');
  return vscode.Uri.joinPath(root.uri, ...rel.split('/'));
}

async function open(rel: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(exampleUri(rel));
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}

function lineOf(doc: vscode.TextDocument, marker: string): number {
  for (let i = 0; i < doc.lineCount; i++) {
    if (doc.lineAt(i).text.includes(marker)) return i;
  }
  throw new Error(`未在 ${doc.uri.fsPath} 找到标记：${marker}`);
}

/**
 * 关掉所有编辑器且不保存 —— E2E 只在内存里改，磁盘上的示例文件必须保持原样。
 *
 * **交付版这里有两处会串烧的缺口**（最终评审 I-3）：
 *
 * 1. 补全浮层还开着时 `revertAndCloseActiveEditor` 不生效。补全用例在浮层上失败
 *    时正是这个状态，于是 `custom_game/demo/main.xml` 的脏缓冲区里留着前面几条
 *    用例插进去的探针行（`        <`、`        <Button `、
 *    `        <Label text="{s:}` 等，后两者是**故意不完整**的）。随后 M4 那条
 *    反向断言用例「写对的示例文件不挨骂」重开同一份文档、断言 0 条诊断，
 *    拿到 `vxml.syntax@17:15` 而变红——**一条 M4 的断言因为一条 M3 用例的抖动
 *    而假红**。先 `hideSuggestWidget` 再 revert。
 * 2. `revertAndCloseActiveEditor` 只作用于**活动**编辑器，一条用例可能留下不止
 *    一份脏缓冲区。改成逐个切过去 revert，直到一份脏的都不剩。
 *
 * 最后那句断言是**把静默变成响的**：脏缓冲区不会让制造它的那条用例红，只会让
 * 后面某条用例莫名其妙地红。断在这里，报错就落在真正的成因上。
 */
async function revertAll(): Promise<void> {
  await vscode.commands.executeCommand('hideSuggestWidget');

  for (let i = 0; i < 20; i++) {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty);
    if (dirty.length === 0) break;
    await vscode.window.showTextDocument(dirty[0], { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await delay(20);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  const stillDirty = vscode.workspace.textDocuments
    .filter((d) => d.isDirty)
    .map((d) => d.uri.fsPath);
  assert.deepEqual(
    stillDirty,
    [],
    `teardown 未能还原脏缓冲区，它会串到下一条用例上造成假红：${stillDirty.join(', ')}`,
  );
}

async function completionLabels(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<string[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    doc.uri,
    pos,
  );
  return (list?.items ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

/**
 * 工作区索引是激活后异步全量扫描的，跨文件候选可能要等一小会儿才出现。
 * 轮询到满足条件为止；超时则原样返回最后一次的候选，交给调用方的断言去报错
 * ——这里绝不能自己 assert，否则超时会报成「等待超时」而盖掉真正的失败原因。
 */
async function waitForCompletion(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  want: (labels: string[]) => boolean,
  timeoutMs = 5000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let labels = await completionLabels(doc, pos);
  while (!want(labels) && Date.now() < deadline) {
    await delay(100);
    labels = await completionLabels(doc, pos);
  }
  return labels;
}

/**
 * 接受补全候选。此前四处（{s:} / Score:{ / .hud-r / src= 逐段）都是
 * `triggerSuggest` -> **盲等 800ms** -> `accept`，全无就绪检查：扩展宿主被瞬时
 * 负载拖过阈值时，accept 落在还没弹出来的浮层上，缓冲区原样不动，断言报成
 * 「补全插错了」——2026-09 那次「4 跑 1 挂」正是这个形态。把 800 提到 1200 只是
 * 把阈值往上推，不解决问题。
 *
 * 改成轮询就绪：反复尝试 accept，直到缓冲区真的变成期望值为止（浮层没弹出来时
 * `acceptSelectedSuggestion` 是空操作）。超时**不** assert，原样返回，让调用方
 * 那句断言去报错——否则超时会报成「等待超时」而盖掉真正的失败原因，与本文件
 * 已有的 waitForCompletion / waitForDiagnostics 同一个范式。
 *
 * **T10 那轮只修了一半**（最终评审 I-3）：重试的是 `accept`，而 `triggerSuggest`
 * **只在循环外调了一次**。浮层如果压根没弹出来——负载高时正是这一种——重试的
 * 就是错误的那一半，8 秒也救不回来。实测的失败形态是「补全根本没被接受」
 * （缓冲区一字不差就是用户敲进去的那串 `<Label text="{` / `.hud-r` / `…/sty`），
 * 而不是「插错了」。所以 `triggerSuggest` 也要进循环。
 *
 * 重弹的节流是必要的：每 50ms 触发一次会让浮层永远处在「刚开始算候选」的状态，
 * 反而更接受不了。这里每 ~500ms 重弹一次，中间的循环轮次只重试 accept。
 *
 * `trigger: false` 用于「接受目录段后补全自动重新弹出」那一环：那里**不能**由
 * 我们自己再 triggerSuggest 一次（一次都不行，包括重试），否则测的就不是
 * retriggerSuggest 了。
 */
async function acceptSuggestionUntil(
  doc: vscode.TextDocument,
  row: number,
  want: string,
  opts: { trigger?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const { trigger = true, timeoutMs = 8000 } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastTrigger = 0;
  while (doc.lineAt(row).text.trim() !== want && Date.now() < deadline) {
    if (trigger && Date.now() - lastTrigger >= 500) {
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
      lastTrigger = Date.now();
      await delay(50);
    }
    await vscode.commands.executeCommand('acceptSelectedSuggestion');
    if (doc.lineAt(row).text.trim() === want) return;
    await delay(50);
  }
}

/** 在文档末尾另起一行插入探针，返回该行行号 */
async function appendProbe(
  editor: vscode.TextEditor,
  doc: vscode.TextDocument,
  probe: string,
): Promise<number> {
  const row = doc.lineCount;
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  await editor.edit((b) => b.insert(end, '\n' + probe));
  return row;
}

suite('Panorama 扩展 · 真实编辑器', () => {
  suiteSetup(async () => {
    // 打开一个 Panorama 文件触发 onLanguage 激活
    await open('panorama/layout/hud/demo.xml');
    const ext = vscode.extensions.getExtension('Kxnrl.vsc-panorama-ext');
    assert.ok(ext, '扩展未被 VSCode 发现');
    await ext.activate();
  });

  teardown(async () => {
    await revertAll();
  });

  test('路径 glob 触发语言激活（这是 minimatch 代理验证不了的）', async () => {
    const vxmlStrict = await open('panorama/layout/custom_game/demo/main.xml');
    assert.equal(vxmlStrict.languageId, 'panorama-vxml');

    const vxmlFull = await open('panorama/layout/hud/demo.xml');
    assert.equal(vxmlFull.languageId, 'panorama-vxml');

    const vcss = await open('panorama/styles/custom_game/demo/main.css');
    assert.equal(vcss.languageId, 'panorama-vcss');
  });

  test('custom_game 下标签候选收窄到 4 面板', async () => {
    const doc = await open('panorama/layout/custom_game/demo/main.xml');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '<Label class="score"');
    const probe = '        <';
    await editor.edit((b) => b.insert(new vscode.Position(at + 1, 0), probe + '\n'));

    const labels = await completionLabels(doc, new vscode.Position(at + 1, probe.length));
    const panels = labels.filter((l) => /^[A-Z]/.test(l));
    assert.deepEqual(
      [...panels].sort(),
      ['Button', 'Image', 'Label', 'Panel'],
      `严格模式下应只有 4 个面板候选，实际：${panels.join(',')}`,
    );
  });

  test('非 custom_game 路径给出完整面板集', async () => {
    const doc = await open('panorama/layout/hud/demo.xml');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '<Label class="title"');
    const probe = '        <';
    await editor.edit((b) => b.insert(new vscode.Position(at + 1, 0), probe + '\n'));

    const labels = await completionLabels(doc, new vscode.Position(at + 1, probe.length));
    const panels = labels.filter((l) => /^[A-Z]/.test(l));
    assert.ok(
      panels.length > 100,
      `完整模式应给出上百个面板候选，实际只有 ${panels.length} 个`,
    );
    assert.ok(panels.includes('ProgressBar'), '完整模式应含白名单外的面板');
  });

  test('Button 的属性候选里没有 text', async () => {
    const doc = await open('panorama/layout/custom_game/demo/main.xml');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '<Label class="score"');
    const probe = '        <Button ';
    await editor.edit((b) => b.insert(new vscode.Position(at + 1, 0), probe + '\n'));

    const labels = await completionLabels(doc, new vscode.Position(at + 1, probe.length));
    assert.ok(!labels.includes('text'), 'Button 不应提示 text —— 文字要用子 Label');
    assert.ok(labels.includes('class'), 'Button 应提示 class');
  });

  test('接受 {s:} 补全后缓冲区逐字正确（mock 建模不了的那条）', async () => {
    const doc = await open('panorama/layout/custom_game/demo/main.xml');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '<Label class="score"');
    const probe = '        <Label text="{';
    const row = at + 1;
    await editor.edit((b) => b.insert(new vscode.Position(row, 0), probe + '\n'));

    const cursor = new vscode.Position(row, probe.length);
    editor.selection = new vscode.Selection(cursor, cursor);

    // 严格模式下绑定候选只有 {s:} 一项，所以 acceptSelectedSuggestion 是确定的
    const labels = await completionLabels(doc, cursor);
    assert.deepEqual(labels, ['{s:}'], `严格模式应只提示 {s:}，实际：${labels.join(',')}`);

    await acceptSuggestionUntil(doc, row, '<Label text="{s:}');

    assert.equal(
      doc.lineAt(row).text.trim(),
      '<Label text="{s:}',
      '接受补全后应得到 text="{s:} —— 既不能吃掉用户敲的 {，也不能重复插入',
    );
  });

  test('词字符紧贴 { 时接受补全不吞掉前面的字符（Task 9：显式 Range 锚定）', async () => {
    // 上面那条用例的 { 前面只有引号，wordPattern 推导凑巧也对；这里 { 紧贴在
    // 词字符 'Score:' 后面（没有空格），Task 9 之前靠 wordPattern 推导替换区间
    // 会把 'Score:' 一起吞掉，变成 text="s:}（丢字符）或更糟。显式区间只覆盖
    // 那一个 {，不受它前面是什么字符影响。
    const doc = await open('panorama/layout/custom_game/demo/main.xml');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '<Label class="score"');
    const probe = '        <Label text="Score:{';
    const row = at + 1;
    await editor.edit((b) => b.insert(new vscode.Position(row, 0), probe + '\n'));

    const cursor = new vscode.Position(row, probe.length);
    editor.selection = new vscode.Selection(cursor, cursor);

    // 严格模式下绑定候选只有 {s:} 一项，acceptSelectedSuggestion 选中的必定
    // 是它——与上面 {s:} 那条用例同样的防错手法，避免断言巧合通过。
    const labels = await completionLabels(doc, cursor);
    assert.deepEqual(labels, ['{s:}'], `严格模式应只提示 {s:}，实际：${labels.join(',')}`);

    await acceptSuggestionUntil(doc, row, '<Label text="Score:{s:}');

    assert.equal(
      doc.lineAt(row).text.trim(),
      '<Label text="Score:{s:}',
      'Score: 必须原样保留 —— 显式替换区间只覆盖那个 {，不依赖 wordPattern 推导',
    );
  });

  test('接受伪类补全后不产生双冒号', async () => {
    const doc = await open('panorama/styles/custom_game/demo/main.css');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '@define accentColor');
    const probe = '.probe:hov';
    const row = at + 1;
    await editor.edit((b) => b.insert(new vscode.Position(row, 0), probe + '\n'));

    const cursor = new vscode.Position(row, probe.length);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      cursor,
    );
    const hover = list?.items.find(
      (i) => (typeof i.label === 'string' ? i.label : i.label.label) === ':hover',
    );
    assert.ok(hover, '应提示 :hover 伪类');

    // 这条用例在 Task 9 之前用语言配置的 wordPattern 求补全会替换掉的区间——
    // 那正是当年出问题的一环。Task 9 起 completeVcss 显式给出
    // replaceStart/replaceEnd，toItem() 把它们转成这里的 hover.range；真实
    // VSCode 接受补全时，range 存在则优先于 wordPattern 推导，wordPattern
    // 那条路径已经不是实际生效的机制了，继续拿它验证测的是个死代码路径。
    // 换成直接用 hover.range 合成结果——它是当前真正决定替换范围的东西。
    const range = hover.range;
    if (!range || !('start' in range)) {
      assert.fail(`伪类候选项应带显式单一 Range（Task 9），实际 range=${JSON.stringify(range)}`);
    }
    const insert =
      typeof hover.insertText === 'string' ? hover.insertText : (hover.insertText?.value ?? '');

    const before = doc.lineAt(row).text;
    const after =
      before.slice(0, range.start.character) + insert + before.slice(range.end.character);

    assert.equal(
      after,
      '.probe:hover',
      `range 覆盖 [${range.start.character}, ${range.end.character})、插入 "${insert}"，合成结果应为 .probe:hover 而非 .probe::hover`,
    );
  });

  // ---- 以下两条走真实的 triggerSuggest + acceptSelectedSuggestion ----
  //
  // 直接调 core 函数或调 provider 回调，都够不到「VSCode 先按 wordPattern
  // （或候选自带的 Range）切出当前词、拿它过滤候选、再按区间替换」这段语义。
  // 最终评审抓出的两条 Critical 恰好只在这一层才会红：候选不带显式区间时，
  // 过滤用的当前词会含前导 '.' / '#'，或替换区间会漏掉已输入的路径段。

  test('接受 . 类名补全后得到的是合法选择器（跨文件索引 + 显式区间）', async () => {
    const doc = await open('panorama/styles/custom_game/demo/main.css');
    const editor = vscode.window.activeTextEditor!;

    // 探针放在文件末尾：一个没有花括号的选择器若插在两条规则中间，容错解析器
    // 会把它和后面那条规则并成一个选择器，连带改变本文件被索引出的类名集合。
    // 放末尾则只多出一个悬空选择器，不影响 .hud-root 等既有定义。
    const probe = '.hud-r';
    const row = await appendProbe(editor, doc, probe);

    const cursor = new vscode.Position(row, probe.length);
    editor.selection = new vscode.Selection(cursor, cursor);

    // 工作区里被 VCSS 定义过的类名只有 hud-root / score / warning /
    // is-active / btn 这几个，'.hud-r' 在真实编辑器的模糊过滤下唯一命中
    // .hud-root，acceptSelectedSuggestion 选中的必定是它——与上面 {s:} 两条
    // 用例同样的防错手法，避免断言巧合通过。
    const labels = await waitForCompletion(doc, cursor, (ls) => ls.includes('.hud-root'));
    assert.ok(
      labels.includes('.hud-root'),
      `'.' 后的类名候选必须带前导点：VCSS 的 wordPattern 把 '.' 算进当前词（'.hud-r'），` +
        `裸名 'hud-root' 与它模糊匹配不上，会被编辑器整批滤掉，用户什么都看不到。` +
        `实际候选：${labels.join(',')}`,
    );

    await acceptSuggestionUntil(doc, row, '.hud-root');

    assert.equal(
      doc.lineAt(row).text.trim(),
      '.hud-root',
      '接受后应得到 .hud-root —— 替换区间要覆盖含前导点的整段 token，插入文本也要带回那个点',
    );
  });

  test('src= 路径补全逐段推进，不把已输入的路径前缀再插一遍', async () => {
    const doc = await open('panorama/layout/custom_game/demo/main.xml');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '<include src=');
    const row = at + 1;

    // 光标停在路径中段（已经打出 s2r://panorama/sty）。VXML 的 wordPattern
    // 不含斜杠，此处的当前词只有 'sty'——候选若是整条 s2r 路径又不带显式区间，
    // 接受后会得到 src="s2r://panorama/s2r://panorama/styles/..."。
    const head = '        <include src="s2r://panorama/sty';
    const probe = head + '" />';
    await editor.edit((b) => b.insert(new vscode.Position(row, 0), probe + '\n'));

    const cursor = new vscode.Position(row, head.length);
    editor.selection = new vscode.Selection(cursor, cursor);

    // examples/ 里样式表只有一个（styles/custom_game/demo/main.css），
    // 所以这一段的候选唯一，acceptSelectedSuggestion 选中的必定是它。
    const labels = await waitForCompletion(doc, cursor, (ls) => ls.includes('styles/'));
    assert.deepEqual(
      labels,
      ['styles/'],
      `src= 应按段补全，当前段候选唯一。实际候选：${labels.join(',')}`,
    );

    await acceptSuggestionUntil(doc, row, '<include src="s2r://panorama/styles/" />');

    assert.equal(
      doc.lineAt(row).text.trim(),
      '<include src="s2r://panorama/styles/" />',
      '接受后只应把已输入的那一段 sty 换成 styles/，路径前缀不能重复出现',
    );

    // 目录段带 retriggerSuggest：上面接受 styles/ 之后补全会自动再弹一次，
    // 所以这里「不」重新 triggerSuggest 也应该有东西可接受。少了这一环，
    // 逐段补全每往下走一段都要用户手按一次 Ctrl+Space。
    await acceptSuggestionUntil(
      doc,
      row,
      '<include src="s2r://panorama/styles/custom_game/" />',
      { trigger: false },
    );
    await vscode.commands.executeCommand('hideSuggestWidget');

    assert.equal(
      doc.lineAt(row).text.trim(),
      '<include src="s2r://panorama/styles/custom_game/" />',
      '接受目录段后应自动重新触发补全，不必用户再按一次 Ctrl+Space',
    );
  });

  // ---- 以下为 M4 Task 10（诊断）追加 ----
  //
  // 单元测试用 mock 走的是「适配层注册的回调被调用后，集合里被 set 了什么」。
  // 这一层要回答的是另一件事：那些诊断到底有没有真的进到编辑器里、成为
  // `vscode.languages.getDiagnostics(uri)` 能读到的东西。语言注册、激活时机、
  // 诊断集合的所有权、offset -> Range 的换算，任何一环接错在这里都会露出来，
  // 而 mock 里全都是通的。
  //
  // 三份 `diagnostics-demo.*` 是**故意写错**的夹具（各带一条注释说明），
  // 与 `main.xml` / `demo.xml` / `main.css` 那三份「正确示例」分开放，免得把
  // 示例文件本身弄成反面教材。

  /** 只看本扩展报的诊断——别的语言服务也可能往同一个 uri 上挂东西 */
  function panoramaDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
    return vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'panorama');
  }

  /**
   * 诊断是打开文档后才算的，且工作区索引还在异步全量扫描。轮询到满足条件为止；
   * 超时则原样返回最后一次的结果，交给调用方的断言去报错——这里绝不能自己
   * assert，否则超时会报成「等待超时」而盖掉真正的失败原因。
   */
  async function waitForDiagnostics(
    uri: vscode.Uri,
    want: (ds: vscode.Diagnostic[]) => boolean,
    timeoutMs = 10000,
  ): Promise<vscode.Diagnostic[]> {
    const deadline = Date.now() + timeoutMs;
    let ds = panoramaDiagnostics(uri);
    while (!want(ds) && Date.now() < deadline) {
      await delay(150);
      ds = panoramaDiagnostics(uri);
    }
    return ds;
  }

  const codeOf = (d: vscode.Diagnostic): string => String(d.code);
  const describeAll = (ds: vscode.Diagnostic[]): string =>
    ds.map((d) => `${codeOf(d)}@${d.range.start.line}:${d.range.start.character}`).join(', ') ||
    '（一条都没有）';

  test('VCSS 的 warning 真的挂到编辑器上，位置也对', async () => {
    const doc = await open('panorama/styles/custom_game/demo/diagnostics-demo.css');
    const ds = await waitForDiagnostics(doc.uri, (d) => d.length > 0);

    assert.equal(ds.length, 1, `应恰好一条诊断，实际：${describeAll(ds)}`);
    const [d] = ds;
    assert.equal(codeOf(d), 'vcss.visibilityHidden');
    assert.equal(d.severity, vscode.DiagnosticSeverity.Warning);
    // 宿主显示语言是英文，所以这里期望英文文案。文案本身的正确性由
        // test/unit/core/i18n/messages.test.ts 与 no-chinese-in-english.test.ts 覆盖；
        // 这里断言的是「扩展确实选中了英文那一份」这条真实链路。
        assert.ok(
          d.message.startsWith('visibility: hidden does not exist in Panorama'),
          `消息不对：${d.message}`,
        );
    // 规格 §10.1：每条 warning 都要给替代写法，不能只说「这个不行」
    assert.ok(d.message.includes('visibility: collapse'), `没给替代写法：${d.message}`);

    // 波浪线必须正好盖在取值 hidden 上（第 9 行、第 13-19 列，0 基）。
    // core 层给的是绝对字符偏移，这里断言的是编辑器实际拿到的行列——
    // 换算写错时 core 的单元测试全绿，只有这条会红。
    assert.equal(doc.lineAt(d.range.start.line).text, '\tvisibility: hidden;');
    assert.deepEqual(
      [d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character],
      [8, 13, 8, 19],
    );
    assert.equal(doc.getText(d.range), 'hidden');
  });

  test('VXML 的结构 warning 真的挂到编辑器上', async () => {
    const doc = await open('panorama/layout/hud/diagnostics-demo.xml');
    const ds = await waitForDiagnostics(doc.uri, (d) => d.length > 0);

    assert.equal(ds.length, 1, `应恰好一条诊断，实际：${describeAll(ds)}`);
    const [d] = ds;
    assert.equal(codeOf(d), 'vxml.rootPanelId');
    assert.equal(d.severity, vscode.DiagnosticSeverity.Warning);
    assert.ok(
          d.message.startsWith('The root panel <Panel> cannot carry an id attribute'),
          `消息不对：${d.message}`,
        );
    assert.equal(doc.lineAt(d.range.start.line).text.trim(), '<Panel id="DiagRoot">');
  });

  test('custom_game 下的白名单违规报 error', async () => {
    const doc = await open('panorama/layout/custom_game/demo/diagnostics-demo.xml');
    const ds = await waitForDiagnostics(doc.uri, (d) => d.length > 0);

    assert.equal(ds.length, 1, `应恰好一条诊断，实际：${describeAll(ds)}`);
    const [d] = ds;
    assert.equal(codeOf(d), 'hud.buttonText');
    // 严格模式的白名单是 error 级：这是规格 §10.3 唯一一组 error
    assert.equal(d.severity, vscode.DiagnosticSeverity.Error);
    // message 由「问题」+ 换行 + 「替代写法」拼成（规格 §10.1 要求每条都给
    // 替代写法），所以这里断言首行逐字相等 + 替代写法在场，而不是整串相等。
    assert.equal(
          d.message.split('\n')[0],
          '<Button> does not support a text attribute; put the button label in a child <Label>',
        );
    assert.ok(
          d.message.includes('<Button class="…"><Label text="OK" /></Button>'),
          `没给替代写法：${d.message}`,
        );
    assert.equal(doc.getText(d.range), 'text');
  });

  /*
     * **唯一能验证 vscode.env.language -> localeOf -> messagesFor 这条真实链路的
     * 测试。** 单元测试用的是 test/mocks/vscode.ts，那份 mock 把 env.language 写死
     * 成 'zh-cn'，验不了真实宿主的取值。
     *
     * M4 里栽过完全同形的一次：类名补全缺触发字符，752 个单元测试加 13 条 E2E
     * 全绿，而真实编辑器里功能是坏的。适配层接线只有 E2E 够得到。
     *
     * 断言分两半：**没有汉字**（漏接线时整串是中文，这一半必红）+ **含特定英文
     * 短语**（万一英文目录被整体写坏成空串或占位符，前一半会漏过去）。
     */
    test('真实宿主的显示语言是英文——诊断消息走英文目录', async () => {
      const doc = await open('panorama/styles/custom_game/demo/diagnostics-demo.css');
      const ds = await waitForDiagnostics(doc.uri, (d) => d.length > 0);
      assert.ok(ds.length > 0, '一条诊断都没拿到，本条会空转');

      for (const d of ds) {
        assert.ok(
          !/[一-龥]/.test(d.message),
          `真实宿主是英文界面，消息里却有汉字（适配层的 locale 接线断了）：${d.message}`,
        );
        assert.ok(d.message.trim() !== '', `消息是空串：${codeOf(d)}`);
      }

      const [first] = ds;
      assert.ok(
        first.message.includes('Panorama') && first.message.includes('collapse'),
        `消息不像预期的英文文案：${first.message}`,
      );
    });

    test('写对的示例文件不挨骂——最多只有跨文件 hint', async () => {
    // 反向断言。上面三条只证明「该报的报了」，这条证明「不该报的没报」：
    // 诊断接线写宽（例如把严格模式判成全局、或把 hint 提级）时上面三条照样绿。
    // 顺序是刻意的：**先**等到另一份文件真的挂上诊断，证明「宿主已激活 + 工作区
    // 索引已扫完」这条链路是活的，再去断言「这一份为 0」。交付版把「为 0」那半段
    // 放在最前且**不等待**，于是「确实一条都没有」与「诊断压根还没算出来」不可
    // 区分，反向断言恒真——本项目已有十三次前科的空转形态。
    const full = await open('panorama/layout/hud/demo.xml');
    // demo.xml 用的三个类名（WindowRoot / title / action）定义在引擎自带样式表里，
    // 不在工作区内，所以是三条 hint——不是 warning，更不是 error。
    const fullDs = await waitForDiagnostics(full.uri, (d) => d.length === 3);
    assert.equal(fullDs.length, 3, `实际：${describeAll(fullDs)}`);
    for (const d of fullDs) {
      assert.equal(codeOf(d), 'vxml.unknownClass');
      assert.equal(d.severity, vscode.DiagnosticSeverity.Hint);
    }

    // 再看严格模式下写对的那份：主动留一个窗口给它「冒出诊断」的机会，等到超时
    // 才断言为 0。接线写宽产生的诊断只要晚到一点点，立刻断言的写法就会漏掉。
    const strict = await open('panorama/layout/custom_game/demo/main.xml');
    const strictDs = await waitForDiagnostics(strict.uri, (d) => d.length > 0, 3000);
    assert.equal(strictDs.length, 0, `严格模式的正确示例不该有诊断：${describeAll(strictDs)}`);
  });

  // =========================================================================
  // 以下为「手动验收清单自动化」追加。
  //
  // 手动 F5 验收抓出过一个 752 条单元测试 + 13 条 E2E 全绿却漏掉的真缺陷，
  // 说明验收清单里有整块内容在自动化之外。下面把其中**结构上够得到**的部分补齐；
  // 够不到的两类（补全的自动触发行为、可视化渲染）**刻意不写**，见文件末尾的说明。
  // =========================================================================

  /**
   * 通用轮询。与 waitForCompletion / waitForDiagnostics 同一个范式：超时**不**
   * assert，原样返回最后一次结果，让调用方那句断言去报错——否则超时会报成
   * 「等待超时」而盖掉真正的失败原因。
   */
  async function waitFor<T>(
    get: () => Thenable<T>,
    want: (v: T) => boolean,
    timeoutMs = 10000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let v = await get();
    while (!want(v) && Date.now() < deadline) {
      await delay(100);
      v = await get();
    }
    return v;
  }

  // -------------------------------------------------------------------------
  // A. 七个配置开关的整条链
  //
  // 链路是 package.json 的键 -> workspace.getConfiguration('panorama') ->
  // readDiagnosticSettings -> applySettings -> 真实的 Diagnostic.severity。
  //
  // **这条链上出过一个「写错了也全绿」的洞**：单元测试的 vscode mock 曾把
  // getConfiguration 的 section 参数整个丢掉，于是节名写错、714 条测试照样全绿。
  // 写入用的是 getConfiguration('panorama.diagnostics').update(key, …)，读取侧
  // （readDiagnosticSettings）用的是 getConfiguration('panorama').get(
  // `diagnostics.${key}`)——两种拼法必须落在同一个键上，这件事只有真实 VSCode
  // 的配置服务能回答，mock 里两边都是自说自话。
  // -------------------------------------------------------------------------

  const DIAGNOSTICS_SECTION = 'panorama.diagnostics';

  async function updateSetting(section: string, key: string, value: unknown): Promise<void> {
    await vscode.workspace
      .getConfiguration(section)
      .update(key, value, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * 改配置跑一段，**无论成败都还原**。
   *
   * 还原写成 `update(key, undefined)`：那是「删掉这条工作区级覆盖」，回落到
   * package.json 声明的默认值；写回一个硬编码的默认字符串则会把默认值抄成第
   * 四份拷贝，将来默认值一改这里就悄悄失准。
   *
   * 不还原的后果不是这条用例红，而是**后面某条用例莫名其妙地红**——本项目已经
   * 因为脏缓冲区串味吃过一次假红（见 revertAll 的注释），配置是同一类全局状态。
   */
  async function withSetting<T>(
    section: string,
    key: string,
    value: unknown,
    body: () => Promise<T>,
  ): Promise<T> {
    await updateSetting(section, key, value);
    try {
      return await body();
    } finally {
      await updateSetting(section, key, undefined);
    }
  }

  interface Probe {
    /** 探针插在**第一条**含这段文本的行之后 */
    readonly after: string;
    readonly text: string;
  }

  async function openWithProbe(file: string, probe?: Probe): Promise<vscode.TextDocument> {
    const doc = await open(file);
    if (!probe) return doc;
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, probe.after);
    await editor.edit((b) => b.insert(new vscode.Position(at + 1, 0), probe.text + '\n'));
    return doc;
  }

  interface SwitchCase {
    readonly key: string;
    readonly file: string;
    readonly ruleId: string;
    readonly defaultSeverity: vscode.DiagnosticSeverity;
    /**
     * 三份 diagnostics-demo.* 夹具只覆盖 webOnlySyntax / structure /
     * customHudWhitelist / unknownClass 四组，剩下三组靠**内存里的探针**补齐：
     * 往夹具文件里加错例会打破既有用例「应恰好一条诊断」的断言，也会让示例
     * 文件本身越来越像反面教材。探针只改缓冲区，teardown 的 revertAll 负责还原。
     */
    readonly probe?: Probe;
  }

  const SWITCH_CASES: readonly SwitchCase[] = [
    {
      key: 'webOnlySyntax',
      file: 'panorama/styles/custom_game/demo/diagnostics-demo.css',
      ruleId: 'vcss.visibilityHidden',
      defaultSeverity: vscode.DiagnosticSeverity.Warning,
    },
    {
      key: 'unknownProperty',
      file: 'panorama/styles/custom_game/demo/diagnostics-demo.css',
      ruleId: 'vcss.unknownProperty',
      defaultSeverity: vscode.DiagnosticSeverity.Hint,
      // 锚点用 width: 100px 而不是 visibility: hidden——后者在文件顶部的注释里
      // 也出现了一次，lineOf 取的是**第一条**匹配行，会把探针插进注释块里。
      probe: { after: 'width: 100px', text: '  frobnicate: 1px;' },
    },
    {
      key: 'unknownClass',
      file: 'panorama/layout/hud/demo.xml',
      ruleId: 'vxml.unknownClass',
      defaultSeverity: vscode.DiagnosticSeverity.Hint,
    },
    {
      key: 'unresolvedReference',
      file: 'panorama/styles/custom_game/demo/diagnostics-demo.css',
      ruleId: 'vcss.unknownDefine',
      defaultSeverity: vscode.DiagnosticSeverity.Warning,
      probe: { after: 'width: 100px', text: '  color: nosuchConstant;' },
    },
    {
      key: 'duplicateId',
      file: 'panorama/layout/hud/diagnostics-demo.xml',
      ruleId: 'vxml.duplicateId',
      defaultSeverity: vscode.DiagnosticSeverity.Hint,
      // 与夹具里 <Panel id="DiagRoot"> 同名，且同在主树作用域内
      probe: { after: '<Label text="#My_Title"', text: '        <Label id="DiagRoot" />' },
    },
    {
      key: 'structure',
      file: 'panorama/layout/hud/diagnostics-demo.xml',
      ruleId: 'vxml.rootPanelId',
      defaultSeverity: vscode.DiagnosticSeverity.Warning,
    },
    {
      key: 'customHudWhitelist',
      file: 'panorama/layout/custom_game/demo/diagnostics-demo.xml',
      ruleId: 'hud.buttonText',
      defaultSeverity: vscode.DiagnosticSeverity.Error,
    },
  ];

  test('七个诊断开关一个不落地被下面的用例覆盖（package.json 是真值来源）', () => {
    // 少了这条，将来新增第八个开关时「没人验它」是静默的：下面那组循环照样
    // 七条全绿。真值来源取运行中的扩展自己的 packageJSON，不是测试里抄一份。
    const ext = vscode.extensions.getExtension('Kxnrl.vsc-panorama-ext');
    assert.ok(ext, '扩展未被 VSCode 发现');
    const props: Record<string, unknown> =
      ext.packageJSON?.contributes?.configuration?.properties ?? {};
    const prefix = 'panorama.diagnostics.';
    const declared = Object.keys(props)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
    const covered = SWITCH_CASES.map((c) => c.key).sort();
    assert.deepEqual(
      covered,
      declared,
      `package.json 声明的诊断开关与本文件覆盖的不一致：声明 [${declared.join(',')}]，覆盖 [${covered.join(',')}]`,
    );
  });

  for (const c of SWITCH_CASES) {
    test(`panorama.diagnostics.${c.key} = off 让 ${c.ruleId} 从编辑器里消失，还原后重新出现`, async () => {
      const doc = await openWithProbe(c.file, c.probe);
      const isRule = (d: vscode.Diagnostic): boolean => codeOf(d) === c.ruleId;
      const has = (ds: vscode.Diagnostic[]): boolean => ds.some(isRule);

      const before = await waitForDiagnostics(doc.uri, has);
      assert.ok(has(before), `默认设置下应有 ${c.ruleId}，实际：${describeAll(before)}`);
      assert.deepEqual(
        [...new Set(before.filter(isRule).map((d) => d.severity))],
        [c.defaultSeverity],
        `${c.ruleId} 的默认级别应是 ${c.defaultSeverity}`,
      );

      await withSetting(DIAGNOSTICS_SECTION, c.key, 'off', async () => {
        const off = await waitForDiagnostics(doc.uri, (ds) => !has(ds), 8000);
        assert.equal(
          off.filter(isRule).length,
          0,
          `${c.key} 设为 off 之后 ${c.ruleId} 仍挂在编辑器上：${describeAll(off)}`,
        );
      });

      // 还原之后必须自己回来。少了这半段，「开关把整个诊断集合永久清空了」
      // 这种坏法照样绿。
      const back = await waitForDiagnostics(doc.uri, has);
      assert.ok(back.some(isRule), `设回默认后 ${c.ruleId} 应重新出现：${describeAll(back)}`);
    });
  }

  // -------------------------------------------------------------------------
  // B. 级别映射
  //
  // 断言的是**可视化渲染背后的那个数据**：编辑器里 hint 画淡虚线、warning 画黄
  // 波浪、error 画红波浪，靠的就是这个枚举。像素查不了，枚举查得了。
  //
  // 上面三条 M4 用例各自钉了一个级别，但它们钉的都是「规则自带的默认级别恰好
  // 等于组默认级别」这种**两边同值**的情形——applySettings 里那句
  // `d.severity === level ? d : { ...d, severity: level }` 的改级分支在默认配置
  // 下根本走不到。所以 B 组的承重部分是下面两条**改级**用例：只有配置把级别改成
  // 与规则自带级别不同的值时，改级分支才会被执行，SEVERITY 映射表也才会被真正
  // 用到第二个键上。
  // -------------------------------------------------------------------------

  test('三个级别落到 VSCode 的三个不同枚举值上', async () => {
    const css = await open('panorama/styles/custom_game/demo/diagnostics-demo.css');
    const warn = await waitForDiagnostics(css.uri, (ds) => ds.length > 0);
    const hud = await open('panorama/layout/custom_game/demo/diagnostics-demo.xml');
    const err = await waitForDiagnostics(hud.uri, (ds) => ds.length > 0);
    const full = await open('panorama/layout/hud/demo.xml');
    const hint = await waitForDiagnostics(full.uri, (ds) => ds.length > 0);

    const pick = (ds: vscode.Diagnostic[], ruleId: string): vscode.Diagnostic => {
      const d = ds.find((x) => codeOf(x) === ruleId);
      assert.ok(d, `没找到 ${ruleId}：${describeAll(ds)}`);
      return d;
    };

    const w = pick(warn, 'vcss.visibilityHidden').severity;
    const e = pick(err, 'hud.buttonText').severity;
    const h = pick(hint, 'vxml.unknownClass').severity;

    assert.equal(w, vscode.DiagnosticSeverity.Warning);
    assert.equal(e, vscode.DiagnosticSeverity.Error);
    assert.equal(h, vscode.DiagnosticSeverity.Hint);
    // 三者互不相同：把 SEVERITY 映射表写成「全都映到 Warning」时，上面三句里
    // 只有两句会红；这一句让「三档塌成一档」这个形态本身也钉住。
    assert.equal(new Set([w, e, h]).size, 3, `三个级别塌成了同一个枚举值：${w}/${e}/${h}`);
  });

  test('unknownProperty 从 hint 改成 warning，编辑器里的 severity 真的跟着变', async () => {
    const doc = await openWithProbe('panorama/styles/custom_game/demo/diagnostics-demo.css', {
      after: 'width: 100px',
      text: '  frobnicate: 1px;',
    });
    const isRule = (d: vscode.Diagnostic): boolean => codeOf(d) === 'vcss.unknownProperty';

    const before = await waitForDiagnostics(doc.uri, (ds) => ds.some(isRule));
    assert.equal(
      before.find(isRule)?.severity,
      vscode.DiagnosticSeverity.Hint,
      `默认应是 Hint：${describeAll(before)}`,
    );

    await withSetting(DIAGNOSTICS_SECTION, 'unknownProperty', 'warning', async () => {
      const after = await waitForDiagnostics(
        doc.uri,
        (ds) => ds.some((d) => isRule(d) && d.severity === vscode.DiagnosticSeverity.Warning),
        8000,
      );
      const d = after.find(isRule);
      assert.ok(d, `改成 warning 后 vcss.unknownProperty 不该消失：${describeAll(after)}`);
      assert.equal(
        d.severity,
        vscode.DiagnosticSeverity.Warning,
        'unknownProperty=warning 时波浪线应是黄的（Warning），而不是规则自带的 Hint',
      );
    });

    const restored = await waitForDiagnostics(
      doc.uri,
      (ds) => ds.some((d) => isRule(d) && d.severity === vscode.DiagnosticSeverity.Hint),
    );
    assert.equal(
      restored.find(isRule)?.severity,
      vscode.DiagnosticSeverity.Hint,
      `还原后应回到 Hint：${describeAll(restored)}`,
    );
  });

  test('webOnlySyntax 从 warning 改成 hint，编辑器里的 severity 也跟着降', async () => {
    // 反方向。只测「升级」的话，「severity 取两者里更重的那个」这种坏法照样绿。
    const doc = await open('panorama/styles/custom_game/demo/diagnostics-demo.css');
    const isRule = (d: vscode.Diagnostic): boolean => codeOf(d) === 'vcss.visibilityHidden';

    const before = await waitForDiagnostics(doc.uri, (ds) => ds.some(isRule));
    assert.equal(
      before.find(isRule)?.severity,
      vscode.DiagnosticSeverity.Warning,
      `默认应是 Warning：${describeAll(before)}`,
    );

    await withSetting(DIAGNOSTICS_SECTION, 'webOnlySyntax', 'hint', async () => {
      const after = await waitForDiagnostics(
        doc.uri,
        (ds) => ds.some((d) => isRule(d) && d.severity === vscode.DiagnosticSeverity.Hint),
        8000,
      );
      const d = after.find(isRule);
      assert.ok(d, `改成 hint 后 vcss.visibilityHidden 不该消失：${describeAll(after)}`);
      assert.equal(
        d.severity,
        vscode.DiagnosticSeverity.Hint,
        'webOnlySyntax=hint 时应降成淡虚线（Hint），而不是继续画黄波浪',
      );
    });

    const restored = await waitForDiagnostics(
      doc.uri,
      (ds) => ds.some((d) => isRule(d) && d.severity === vscode.DiagnosticSeverity.Warning),
    );
    assert.equal(
      restored.find(isRule)?.severity,
      vscode.DiagnosticSeverity.Warning,
      `还原后应回到 Warning：${describeAll(restored)}`,
    );
  });

  // -------------------------------------------------------------------------
  // C. 跨文件导航与颜色
  // -------------------------------------------------------------------------

  /** executeDefinitionProvider 的返回值可能是 Location 也可能是 LocationLink */
  function asLocation(x: vscode.Location | vscode.LocationLink): vscode.Location {
    return 'uri' in x ? x : new vscode.Location(x.targetUri, x.targetRange);
  }

  const posix = (p: string): string => p.replace(/\\/g, '/');

  /** class="hud-root" 里 hud-root 这个词中间的位置 */
  function classNamePosition(doc: vscode.TextDocument): vscode.Position {
    const at = lineOf(doc, '<Panel class="hud-root">');
    const col = doc.lineAt(at).text.indexOf('hud-root');
    assert.ok(col > 0, '夹具里应有 class="hud-root"');
    return new vscode.Position(at, col + 2);
  }

  test('类名跳转定义落到 VCSS 里定义它的那条规则上（跨文件）', async () => {
    const doc = await open('panorama/layout/custom_game/demo/main.xml');
    const pos = classNamePosition(doc);

    const raw = await waitFor(
      () =>
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          'vscode.executeDefinitionProvider',
          doc.uri,
          pos,
        ),
      (ls) => (ls ?? []).length > 0,
    );
    const locs = (raw ?? []).map(asLocation);
    assert.equal(
      locs.length,
      1,
      `hud-root 在工作区里只被定义一次，实际拿到 ${locs.length} 处：${locs.map((l) => posix(l.uri.fsPath)).join(', ')}`,
    );

    const [loc] = locs;
    assert.ok(
      posix(loc.uri.fsPath).endsWith('panorama/styles/custom_game/demo/main.css'),
      `跳转目标文件不对：${posix(loc.uri.fsPath)}`,
    );

    // 光落到对的文件还不够——落在文件头（0:0）也算「落到对的文件」。这里断言
    // 区间逐字盖住选择器里的那个类名。
    const target = await vscode.workspace.openTextDocument(loc.uri);
    assert.equal(target.getText(loc.range), 'hud-root', '跳转区间应正好盖住类名');
    assert.equal(target.lineAt(loc.range.start.line).text, '.hud-root', '应落在那条规则的选择器行');
  });

  test('类名查找引用同时给出定义处与使用处（跨文件）', async () => {
    const doc = await open('panorama/layout/custom_game/demo/main.xml');
    const pos = classNamePosition(doc);

    const raw = await waitFor(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          doc.uri,
          pos,
        ),
      (ls) => (ls ?? []).length >= 2,
    );
    const paths = (raw ?? []).map((l) => posix(l.uri.fsPath));

    // 定义处（VCSS）与使用处（VXML）**两侧都要在**：只返回定义就退化成
    // 「跳转定义」的别名，只返回使用处则永远找不到样式写在哪儿。
    assert.ok(
      paths.some((p) => p.endsWith('panorama/styles/custom_game/demo/main.css')),
      `引用列表里少了 VCSS 定义处：${paths.join(', ')}`,
    );
    assert.ok(
      paths.some((p) => p.endsWith('panorama/layout/custom_game/demo/main.xml')),
      `引用列表里少了 VXML 使用处：${paths.join(', ')}`,
    );
    assert.equal(paths.length, 2, `工作区里 hud-root 只有一处定义一处使用：${paths.join(', ')}`);
  });

  test('八位 #RRGGBBAA 被取色器认出来，alpha 不是被丢掉的（标准 CSS 认不了这种写法）', async () => {
    const doc = await open('panorama/styles/custom_game/demo/main.css');

    const raw = await waitFor(
      () =>
        vscode.commands.executeCommand<vscode.ColorInformation[]>(
          'vscode.executeDocumentColorProvider',
          doc.uri,
        ),
      (cs) => (cs ?? []).length > 0,
      5000,
    );
    const colors = raw ?? [];
    const texts = colors.map((c) => doc.getText(c.range));
    assert.deepEqual(
      texts,
      ['#3281AC', '#14202b', '#1e2d3d', '#00000050'],
      `main.css 里的色值应被逐个认出（含 @define 值里的两个），实际：${texts.join(', ')}`,
    );

    const eight = colors[texts.indexOf('#00000050')].color;
    assert.equal(eight.red, 0, '#00000050 的 R 应为 0');
    assert.equal(eight.green, 0, '#00000050 的 G 应为 0');
    assert.equal(eight.blue, 0, '#00000050 的 B 应为 0');
    assert.ok(
      Math.abs(eight.alpha - 0x50 / 255) < 1e-9,
      `八位色值的 alpha 必须来自最后两位（0x50/255 = ${0x50 / 255}），实际 ${eight.alpha}——` +
        `丢掉 alpha 的实现会给出 1，那正是标准 CSS 取色器认不了这种写法的原因`,
    );

    const six = colors[texts.indexOf('#3281AC')].color;
    assert.equal(six.alpha, 1, '六位色值没有 alpha 段，应补 1');
    assert.ok(Math.abs(six.red - 0x32 / 255) < 1e-9, `#3281AC 的 R 不对：${six.red}`);
    assert.ok(Math.abs(six.green - 0x81 / 255) < 1e-9, `#3281AC 的 G 不对：${six.green}`);
    assert.ok(Math.abs(six.blue - 0xac / 255) < 1e-9, `#3281AC 的 B 不对：${six.blue}`);
  });

  // -------------------------------------------------------------------------
  // D. src= 的逐段路径补全（在**非** custom_game 的布局里）
  //
  // M3 那个 Critical 的形态是：候选给的是整条 s2r 路径又不带显式区间，VXML 的
  // wordPattern 不含斜杠，于是接受后把已输入的前缀又拼了一遍
  // （src="s2r://panorama/s2r://panorama/styles/..."）。只看候选列表看不出这件
  // 事——列表里那条候选长得完全正确。所以这两条都走「触发补全 -> 接受候选 ->
  // 读回文档文本」，断言落在**缓冲区最终文本**上。
  //
  // 既有那条 src= 用例走的是 custom_game/demo/main.xml、从半截目录名 'sty'
  // 起步、只接受目录段。这里补的是它够不到的两个位置：完整模式的布局、以及
  // 固定头部与叶子文件名这两种边界段。
  //
  // **两条都另外钉一次候选项自带的显式区间**，理由是实测出来的：把
  // completeVxml 里逐段候选的 replaceStart/replaceEnd 删掉（只留 insertText），
  // 31 条 E2E 一条都不红。原因是 VXML 的 wordPattern（`[a-zA-Z0-9_\-{}:#.]+`）
  // 恰好只把 '/' 排除在词字符之外，而分段的切点也正是最后一个 '/'——两者在
  // 路径这种输入上逐例重合，缓冲区最终文本因此看不出差别。只断言最终文本的话，
  // 「逐段候选不带显式区间」这件事在 E2E 上是不可证伪的；区间断言把它补上。
  // -------------------------------------------------------------------------

  /** 候选项必须带**单一** Range（不是 inserting/replacing 那种二元组） */
  function singleRange(item: vscode.CompletionItem, what: string): vscode.Range {
    const r = item.range;
    if (!r || !('start' in r)) {
      assert.fail(`${what} 应带显式单一 Range，实际 range=${JSON.stringify(r)}`);
    }
    return r;
  }

  async function completionItem(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    label: string,
  ): Promise<vscode.CompletionItem> {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    );
    const item = (list?.items ?? []).find(
      (i) => (typeof i.label === 'string' ? i.label : i.label.label) === label,
    );
    assert.ok(item, `候选列表里没有 ${label}`);
    return item;
  }

  test('src= 从固定头部起步：接受第一段不会把 s2r://panorama/ 再插一遍（完整模式）', async () => {
    const doc = await open('panorama/layout/hud/demo.xml');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '<include src=');
    const row = at + 1;

    // 头部 s2r://panorama/ 里那个 '//' 会被朴素的按斜杠切段切出一个空段，
    // 补出 's2r:/' 这种半截协议头——接受了也没往前推进。头部必须与它后面的
    // 第一个目录段作为一整块给出。
    const head = '        <include src="s2r://panorama/';
    const probe = head + '" />';
    await editor.edit((b) => b.insert(new vscode.Position(row, 0), probe + '\n'));

    const cursor = new vscode.Position(row, head.length);
    editor.selection = new vscode.Selection(cursor, cursor);

    // examples/ 里的样式表全在 styles/ 下，所以这一段的候选唯一，
    // acceptSelectedSuggestion 选中的必定是它。
    const labels = await waitForCompletion(doc, cursor, (ls) => ls.includes('styles/'));
    assert.deepEqual(labels, ['styles/'], `头部之后的第一段候选应唯一，实际：${labels.join(',')}`);

    // 光标正停在分段边界上，这一段一个字符都还没敲，所以显式区间是**光标处的
    // 空区间**——它必须存在，否则替换范围就交回给 wordPattern 去猜了。
    const r = singleRange(await completionItem(doc, cursor, 'styles/'), '逐段路径候选');
    assert.deepEqual(
      [r.start.line, r.start.character, r.end.line, r.end.character],
      [row, head.length, row, head.length],
      '分段边界上的候选，显式区间应是光标处的空区间',
    );

    await acceptSuggestionUntil(doc, row, '<include src="s2r://panorama/styles/" />');
    await vscode.commands.executeCommand('hideSuggestWidget');

    assert.equal(
      doc.lineAt(row).text.trim(),
      '<include src="s2r://panorama/styles/" />',
      '接受后只应在头部后面接上 styles/，头部不能重复出现，也不能被切成半截协议头',
    );
  });

  test('src= 末段是文件名时，已输入的目录前缀不被重复插入（完整模式）', async () => {
    const doc = await open('panorama/layout/hud/demo.xml');
    const editor = vscode.window.activeTextEditor!;
    const at = lineOf(doc, '<include src=');
    const row = at + 1;

    // 叶子段（文件名）与目录段走的是同一条 chunk 逻辑的两个分支：没有尾随斜杠、
    // 不带 retriggerSuggest。既有用例只接受过目录段，这个分支在 E2E 上是空白。
    const head = '        <include src="s2r://panorama/styles/custom_game/demo/mai';
    const probe = head + '" />';
    await editor.edit((b) => b.insert(new vscode.Position(row, 0), probe + '\n'));

    const cursor = new vscode.Position(row, head.length);
    editor.selection = new vscode.Selection(cursor, cursor);

    // 这一段有两个候选（main.vcss_c / diagnostics-demo.vcss_c），但候选项自带的
    // 显式区间只覆盖已输入的 'mai'，编辑器拿它做模糊过滤后只剩 main.vcss_c
    // （diagnostics-demo.vcss_c 里 'm' 之后没有 'a'），所以
    // acceptSelectedSuggestion 选中的仍是确定的。
    const labels = await waitForCompletion(doc, cursor, (ls) => ls.includes('main.vcss_c'));
    assert.deepEqual(
      [...labels].sort(),
      ['diagnostics-demo.vcss_c', 'main.vcss_c'],
      `末段应给出该目录下的样式表文件名，实际：${labels.join(',')}`,
    );

    // 显式区间只能覆盖已输入的那一段 'mai'——覆盖到前面的目录段就会把它们
    // 一起换掉，覆盖不到就得靠 wordPattern 去猜。
    const r = singleRange(await completionItem(doc, cursor, 'main.vcss_c'), '逐段路径候选');
    assert.deepEqual(
      [r.start.line, r.start.character, r.end.line, r.end.character],
      [row, head.length - 'mai'.length, row, head.length],
      '末段候选的显式区间应正好覆盖已输入的 mai，一个字符不多一个不少',
    );

    const want = '<include src="s2r://panorama/styles/custom_game/demo/main.vcss_c" />';
    await acceptSuggestionUntil(doc, row, want);
    await vscode.commands.executeCommand('hideSuggestWidget');

    assert.equal(
      doc.lineAt(row).text.trim(),
      want,
      '接受后只应把已输入的那一段 mai 换成 main.vcss_c，前面三段目录不能重复出现',
    );
  });

  // -------------------------------------------------------------------------
  // E. 面板类型补全在两种模式下的数量差
  //
  // 「custom_game 下恰好 4 种、hud 下远多于 4」这两个方向，上面既有的两条用例
  // 已经各钉了一个（4 面板 / >100 且含 ProgressBar）。这里补的是它们够不到的
  // 那一层：**这个收窄到底是不是配置说了算**。既有两条用例在「把
  // custom_game 这个路径段写死在代码里」的实现下照样全绿——两条用例用的正好
  // 就是 custom_game/ 与 hud/ 这两个路径。
  // -------------------------------------------------------------------------

  const panelLabels = (labels: string[]): string[] => labels.filter((l) => /^[A-Z]/.test(l));

  /** 在 <Panel> 内部另起一行，光标停在 '<' 之后 */
  async function tagProbe(
    doc: vscode.TextDocument,
    marker: string,
  ): Promise<vscode.Position> {
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const at = lineOf(doc, marker);
    const probe = '        <';
    await editor.edit((b) => b.insert(new vscode.Position(at + 1, 0), probe + '\n'));
    return new vscode.Position(at + 1, probe.length);
  }

  test('把 hud/ 划进 customHudLayout.include，它的面板候选就收窄到 4 个', async () => {
    const doc = await open('panorama/layout/hud/demo.xml');
    const pos = await tagProbe(doc, '<Label class="title"');

    const wide = panelLabels(await completionLabels(doc, pos));
    assert.ok(wide.length > 100, `默认设置下 hud/ 应给完整面板集，实际只有 ${wide.length} 个`);

    await withSetting('panorama', 'customHudLayout.include', ['**/layout/hud/**'], async () => {
      const labels = await waitForCompletion(doc, pos, (ls) => panelLabels(ls).length === 4);
      assert.deepEqual(
        [...panelLabels(labels)].sort(),
        ['Button', 'Image', 'Label', 'Panel'],
        `hud/ 被划进白名单 glob 后应只剩 4 个面板候选，实际：${panelLabels(labels).join(',')}`,
      );
    });

    const back = await waitForCompletion(doc, pos, (ls) => panelLabels(ls).length > 100);
    assert.ok(panelLabels(back).length > 100, `还原配置后应回到完整面板集，实际 ${panelLabels(back).length} 个`);
  });

  test('把 customHudLayout.include 清空，custom_game/ 就回到完整面板集', async () => {
    const doc = await open('panorama/layout/custom_game/demo/main.xml');
    const pos = await tagProbe(doc, '<Label class="score"');

    const narrow = panelLabels(await completionLabels(doc, pos));
    assert.equal(narrow.length, 4, `默认设置下 custom_game/ 应只有 4 个面板候选，实际：${narrow.join(',')}`);

    await withSetting('panorama', 'customHudLayout.include', [], async () => {
      const labels = await waitForCompletion(doc, pos, (ls) => panelLabels(ls).length > 100);
      const panels = panelLabels(labels);
      assert.ok(
        panels.length > 100,
        `白名单 glob 清空后 custom_game/ 应给出完整面板集，实际只有 ${panels.length} 个`,
      );
      assert.ok(panels.includes('ProgressBar'), '完整模式应含白名单外的面板');
    });

    const back = await waitForCompletion(doc, pos, (ls) => panelLabels(ls).length === 4);
    assert.deepEqual(
      [...panelLabels(back)].sort(),
      ['Button', 'Image', 'Label', 'Panel'],
      `还原配置后应回到 4 面板，实际：${panelLabels(back).join(',')}`,
    );
  });

  // -------------------------------------------------------------------------
  // F. 嵌入式 MCP（真实宿主链路）
  //
  // 单元测试盖住的是「工具函数对、server 装配对」；daemon.http.test.ts 盖住的
  // 是「构建产物在裸 node 里能跑」。这两层都够不到的，是**扩展宿主真的把
  // daemon spawn 起来了**这条链路：ELECTRON_RUN_AS_NODE、extensionUri 定位
  // dist/mcp-daemon.cjs、locale 传递、onStartupFinished 激活。任何一环断掉，
  // 下面第一条就会红。
  //
  // 端口用默认 4377——正是用户不开任何配置时会得到的那个，别把测试接到
  // 一条用户走不到的路径上。
  // -------------------------------------------------------------------------

  const MCP_BASE = 'http://127.0.0.1:4377';

  async function healthUp(): Promise<boolean> {
    try {
      const res = await fetch(`${MCP_BASE}/health`, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Streamable HTTP 的应答是 SSE 帧，抽出 data 行再 JSON.parse */
  async function mcpRpc(method: string, params?: unknown, id = 1): Promise<unknown> {
    const res = await fetch(`${MCP_BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
    assert.equal(res.status, 200, `${method} 应答 200，实际 ${res.status}`);
    const body = await res.text();
    return JSON.parse(
      body
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join(''),
    ).result;
  }

  test('扩展激活后 MCP daemon 真的在服务（spawn 链路 + 默认端口）', async () => {
    const up = await waitFor(() => Promise.resolve(healthUp()), (v) => v, 20_000);
    assert.ok(up, '20s 内 daemon 未在 127.0.0.1:4377 就绪——扩展宿主的 spawn 链路断了');
  });

  test('真实宿主拉起的 daemon：validate 工具可用且走英文目录', async () => {
    assert.ok(await healthUp(), '上一条用例之后 daemon 不该消失');

    await mcpRpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0' },
    });

    const res = (await mcpRpc(
      'tools/call',
      {
        name: 'validate',
        arguments: { path: exampleUri('panorama/layout/custom_game/demo/diagnostics-demo.xml').fsPath },
      },
      2,
    )) as { content: { text: string }[] };
    const parsed = JSON.parse(res.content[0].text) as {
      mode: string;
      diagnostics: { ruleId: string; message: string }[];
    };

    assert.equal(parsed.mode, 'customHudLayout');
    const buttonText = parsed.diagnostics.find((d) => d.ruleId === 'hud.buttonText');
    assert.ok(buttonText, `应报出 hud.buttonText，实际：${parsed.diagnostics.map((d) => d.ruleId).join(',')}`);
    // 与诊断那条 E2E 同一理由：真实宿主是英文界面，daemon 的 locale 由扩展
    // spawn 时传入——这条断言钉住「扩展 -> daemon 的 locale 传递」没断
    assert.match(buttonText.message, /^<Button> does not support a text attribute/);
  });
});
