import type { VcssDeclaration, VcssDocument, VcssKeyframes, VcssRule } from '../vcss/ast';
import type { PropertyRegistry } from '../data/properties';
import type { WorkspaceIndex } from '../index/workspace-index';
import type { Diagnostic, RuleId } from './types';
import type { Messages } from '../i18n/types';

/**
 * 规格 §10.1 的 VCSS 部分：9 条「能证明是错的」warning。跨文件的两条
 * （unknownDefine / unknownKeyframes）需要工作区索引，留给后续任务。
 *
 * 三个已被语料证明会踩的反例，全部靠「只查声明的 property / value 字段，
 * 绝不对选择器整体做文本搜索」天然绕开——不是额外加的特判：
 * - `.loadout-grid { width: 10px; }`：'grid' 只出现在选择器里，本文件从不
 *   读取 rule.selector 之外的文本去找属性名，所以不会命中。
 * - `layout-position: fixed;`：declaration.property 是解析器已经切好的
 *   完整属性名 'layout-position'，与 'position' 做精确相等比较，不是子串。
 * - `.HUD--has-c4--on-pickup { }`：'--' 只出现在选择器里；customProperty
 *   只查 declaration.property 是否以 '--' 开头、以及 value 里的 var(--...)。
 */
function mk(ruleId: RuleId, start: number, end: number, message: string, fix: string): Diagnostic {
  return { ruleId, severity: 'warning', start, end, message, fix };
}

/** 规格 §10.2 的两条「只是没见过」——数据源是人工清单，级别只能到 hint */
function mkHint(ruleId: RuleId, start: number, end: number, message: string, fix: string): Diagnostic {
  return { ruleId, severity: 'hint', start, end, message, fix };
}

// ---------------------------------------------------------------------------
// 1. Web 独有、Panorama 不存在的属性
// ---------------------------------------------------------------------------

function fallbackWebOnlyFix(prop: string, msg: Messages): string {
  return prop.startsWith('flex-')
    ? msg.vcss.webOnlyPropertyFixFlex()
    : msg.vcss.webOnlyPropertyFixGrid();
}

/**
 * 这个属性是否由 vcss.webOnlyProperty（§10.1）负责，以及给出的替代写法。
 *
 * 抽成单独的谓词是为了让 Task 5 的 vcss.unknownProperty 能复用**同一个**判断
 * 去让位——display / float / flex* / grid* 都不在 properties 段里，两条规则会
 * 落在同一个属性名区间上说同一个根因。两边各写一份判据迟早会漂移，因此只有
 * 一份，checkWebOnlyProperty 与 checkUnknownProperty 都从这里取。
 */
function webOnlyFixFor(prop: string, props: PropertyRegistry, msg: Messages): string | undefined {
  const hint = props.webOnlyHint(prop);
  // webOnlyHint 直接用 [] 索引 JSON 对象、没有 hasOwn 守卫；防御性地只信
  // 字符串结果，避免属性名恰好撞上 'constructor' 这类原型链成员时把一个
  // 函数对象当成 fix 塞进 Diagnostic（真实语料不会出现这种属性名，这里
  // 只是不信任上游返回值本身的类型承诺）。
  if (typeof hint === 'string') return hint;
  // data/vcss-properties.json 的 webOnly 段只收录了 flex / grid 的基础形态，
  // 没有穷举全部变体（flex-shrink、grid-area 等）。这些变体在 Panorama 里
  // 同样不存在，用前缀兜底。前缀必须带上连字符（'flex-' 不是 'flex'）——
  // 'flex' 本身已经是 webOnly 里的精确键，会在上面 hint 分支命中。
  if (prop.startsWith('flex-') || prop.startsWith('grid-')) return fallbackWebOnlyFix(prop, msg);
  return undefined;
}

/**
 * transition 简写的机械化拆分。只认**单段、形态规整**的写法
 * （`transition: width 0.5s ease-out`）：属性名、一个时长、可选 timing、
 * 可选第二个时长（delay）。逗号分隔的多段简写或含 cubic-bezier/steps
 * 函数的，形态不再是唯一解，不产出 edits——文字版 fix 仍然给出。
 */
const TIMING_KEYWORDS = new Set(['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']);
const TIME_VALUE_RE = /^[-+.]?\d[\d.]*m?s$/;

function transitionSplitEdit(
  text: string,
  decl: VcssDeclaration,
): readonly { start: number; end: number; text: string }[] | undefined {
  if (decl.property !== 'transition' || decl.value.includes(',')) return undefined;

  const tokens = tokenizeValue(decl.value);
  if (tokens.length === 0) return undefined;

  // 首段必是属性名（标识符形态）；其后至多两个时长与一个 timing 关键字
  const [propToken, ...rest] = tokens;
  if (!/^[-\w]+$/.test(propToken)) return undefined;

  let duration = '0s';
  let timing = 'ease';
  let delay = '0s';
  let timingSeen = false;
  const seenTimes: string[] = [];
  for (const t of rest) {
    if (TIME_VALUE_RE.test(t)) {
      seenTimes.push(t);
      continue;
    }
    if (TIMING_KEYWORDS.has(t)) {
      if (timingSeen) return undefined; // 两个 timing 关键字，形态不唯一
      timing = t;
      timingSeen = true;
      continue;
    }
    return undefined; // cubic-bezier(...) / steps(...) / 未知 token：不猜
  }
  if (seenTimes.length > 0) duration = seenTimes[0];
  if (seenTimes.length > 1) delay = seenTimes[1];
  if (seenTimes.length > 2) return undefined;

  // 缩进取声明所在行的行首空白，拆出的三行与原声明对齐
  const lineStart = text.lastIndexOf('\n', decl.propertyStart) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, decl.propertyStart))![0];

  const replacement =
    `transition-property: ${propToken};\n${indent}transition-duration: ${duration};\n` +
    `${indent}transition-timing-function: ${timing};\n${indent}transition-delay: ${delay}`;
  // 覆盖整条声明（属性名到取值末尾）；行尾原有的 ';' 落在区间外，恰好留给最后一行
  return [{ start: decl.propertyStart, end: decl.valueEnd, text: replacement }];
}

function checkWebOnlyProperty(
  decl: VcssDeclaration,
  text: string,
  props: PropertyRegistry,
  msg: Messages,
  out: Diagnostic[],
): void {
  const fix = webOnlyFixFor(decl.property, props, msg);
  if (fix === undefined) return;
  const edits = transitionSplitEdit(text, decl);
  const base = mk(
    'vcss.webOnlyProperty',
    decl.propertyStart,
    decl.propertyEnd,
    msg.vcss.webOnlyProperty(decl.property),
    fix,
  );
  out.push(edits ? { ...base, edits } : base);
}

// ---------------------------------------------------------------------------
// 2. position 取值为 Web 的定位关键字
// ---------------------------------------------------------------------------

// 规格 §10.1 原文只列了这四个（没有 'static'）。Panorama 的 position 只有
// 「x y z 三轴偏移」这一种形态，理论上 'static' 同样是「能证明是错的」，
// 但规格明确只写了这四个，语料上也不存在（已用 grep 核实两个构建都是 0），
// 不额外扩大规则覆盖面，照规格原文实现。
const POSITION_WEB_KEYWORDS = new Set(['absolute', 'relative', 'fixed', 'sticky']);

function checkPositionKeyword(decl: VcssDeclaration, msg: Messages, out: Diagnostic[]): void {
  // 属性名必须精确等于 'position'——'layout-position' 是 Panorama 自己的
  // 属性（语料里 3 处 position: fixed 全部来自它），子串匹配会把它错认成
  // 违规的 position。decl.property 是解析器已切好的完整属性名，这里天然
  // 就是精确比较，不是子串搜索。
  if (decl.property !== 'position') return;
  if (!POSITION_WEB_KEYWORDS.has(decl.value)) return;
  out.push(
    mk(
      'vcss.positionKeyword',
      decl.valueStart,
      decl.valueEnd,
      msg.vcss.positionKeyword(decl.value),
      msg.vcss.positionKeywordFix(),
    ),
  );
}

// ---------------------------------------------------------------------------
// 3. vw / vh / em / rem 单位
// ---------------------------------------------------------------------------

// 必须要求前面有数字：'font-family: emoji' 这类裸标识符不能命中。
// 捕获组 1 是数字左侧的分隔符（或空字符串——字符串开头场景），用来把
// 診断区间精确落在「数字+单位」本身，不含前导空白/逗号/括号。
const WEB_UNIT_RE = /(^|[\s(,])([-+.]?\d[\d.]*)(vw|vh|em|rem)\b/g;

function webUnitFix(unit: string, msg: Messages): string {
  return unit === 'vw' || unit === 'vh'
    ? msg.vcss.webUnitFixViewport(unit)
    : msg.vcss.webUnitFixFontRelative(unit);
}

function checkWebUnit(
  value: string,
  valueStart: number,
  msg: Messages,
  out: Diagnostic[],
): void {
  WEB_UNIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WEB_UNIT_RE.exec(value))) {
    const numStart = m.index + m[1].length;
    const start = valueStart + numStart;
    const end = start + m[2].length + m[3].length;
    out.push(
      mk(
        'vcss.webUnit',
        start,
        end,
        msg.vcss.webUnit(m[3]),
        webUnitFix(m[3], msg),
      ),
    );
    if (m.index === WEB_UNIT_RE.lastIndex) WEB_UNIT_RE.lastIndex++;
  }
}

// ---------------------------------------------------------------------------
// 4. 伪元素 ::before / ::after（Panorama 不支持任何双冒号伪元素）
// ---------------------------------------------------------------------------

const PSEUDO_ELEMENT_RE = /::[-\w]*/g;

function checkPseudoElement(rule: VcssRule, msg: Messages, out: Diagnostic[]): void {
  PSEUDO_ELEMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PSEUDO_ELEMENT_RE.exec(rule.selector))) {
    const start = rule.selectorStart + m.index;
    const end = start + m[0].length;
    out.push(
      mk(
        'vcss.pseudoElement',
        start,
        end,
        msg.vcss.pseudoElement(m[0]),
        msg.vcss.pseudoElementFix(),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 5. visibility: hidden（应为 collapse）
// ---------------------------------------------------------------------------

function checkVisibilityHidden(decl: VcssDeclaration, msg: Messages, out: Diagnostic[]): void {
  if (decl.property !== 'visibility' || decl.value !== 'hidden') return;
  out.push({
    ...mk(
      'vcss.visibilityHidden',
      decl.valueStart,
      decl.valueEnd,
      msg.vcss.visibilityHidden(),
      msg.vcss.visibilityHiddenFix(),
    ),
    edits: [{ start: decl.valueStart, end: decl.valueEnd, text: 'collapse' }],
  });
}

// ---------------------------------------------------------------------------
// 6. CSS 自定义属性 --x 与 var(--x)（应为 @define）
// ---------------------------------------------------------------------------

function checkCustomPropertyDeclare(
  decl: VcssDeclaration,
  msg: Messages,
  out: Diagnostic[],
): void {
  if (!decl.property.startsWith('--')) return;
  out.push(
    mk(
      'vcss.customProperty',
      decl.propertyStart,
      decl.propertyEnd,
      msg.vcss.customProperty(decl.property),
      msg.vcss.customPropertyFix(decl.property),
    ),
  );
}

/** 从 openIdx（'(' 本身）起找配对的 ')'；未闭合时退化到字符串末尾，不抛异常 */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length > 0 ? text.length - 1 : 0;
}

const VAR_REF_RE = /\bvar\(\s*(--[\w-]+)/g;

function checkCustomPropertyVarUsage(
  value: string,
  valueStart: number,
  msg: Messages,
  out: Diagnostic[],
): void {
  VAR_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_REF_RE.exec(value))) {
    const openParenIdx = value.indexOf('(', m.index);
    const closeParenIdx = findMatchingParen(value, openParenIdx);
    const start = valueStart + m.index;
    const end = valueStart + closeParenIdx + 1;
    out.push(
      mk(
        'vcss.customProperty',
        start,
        end,
        msg.vcss.varReference(m[1]),
        msg.vcss.varReferenceFix(),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 7. @keyframes 名字未加引号
// ---------------------------------------------------------------------------

function checkKeyframesQuoting(kf: VcssKeyframes, msg: Messages, out: Diagnostic[]): void {
  if (kf.quoted) return;
  out.push({
    ...mk(
      'vcss.keyframesUnquoted',
      kf.nameStart,
      kf.nameEnd,
      msg.vcss.keyframesUnquoted(kf.name),
      msg.vcss.keyframesUnquotedFix(kf.name),
    ),
    edits: [{ start: kf.nameStart, end: kf.nameEnd, text: `"${kf.name}"` }],
  });
}

// ---------------------------------------------------------------------------
// 8. box-shadow 颜色在前（官方语法：[fill|hollow|inset] 颜色 x y blur spread）
// ---------------------------------------------------------------------------

// 语料实测的首 token 形态分布（两个构建合计）：none/十六进制/fill/hollow/
// inset/函数调用/@define 常量名/裸颜色关键字都会出现在这个位置。唯一能
// 稳定证明「顺序反了」的信号是：跳过 fill/hollow/inset/none 这几个已知
// 关键字后，剩下的第一个 token 是不是长得像长度值（数字/符号开头）——
// @define 常量名（如 shadowOffset、box_shadow_on_color）有 63 处之多，
// 一旦误判成「不是颜色就报」会把这 63 处全部当成误报，因此不能用
// 「首 token 不是颜色」这个否定式判据，只能用「首 token 长得像长度值」
// 这个肯定式判据。
const BOX_SHADOW_SKIP = new Set(['inset', 'fill', 'hollow', 'none']);
const LOOKS_LENGTHISH = /^[-+.\d]/;

/** 按空白切分 token，但跳过括号内部的空白——rgba(14, 209, 95, 0.082) 是一个 token */
function tokenizeValue(value: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i])) i++;
    if (i >= value.length) break;
    const start = i;
    let depth = 0;
    while (i < value.length && (depth > 0 || !/\s/.test(value[i]))) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') depth = Math.max(0, depth - 1);
      i++;
    }
    tokens.push(value.slice(start, i));
  }
  return tokens;
}

function checkBoxShadowColorFirst(
  decl: VcssDeclaration,
  msg: Messages,
  out: Diagnostic[],
): void {
  if (decl.property !== 'box-shadow') return;
  const tokens = tokenizeValue(decl.value);
  let i = 0;
  const leading: string[] = [];
  while (i < tokens.length && BOX_SHADOW_SKIP.has(tokens[i])) {
    leading.push(tokens[i]);
    i++;
  }
  const first = tokens[i];
  if (first === undefined || !LOOKS_LENGTHISH.test(first)) return;

  // 机械化重排只认规范形：[fill|hollow|inset]* 长度串+ 单一尾token=颜色。
  // 尾部还有其它非长度 token（Web 允许 inset 收尾）时形态不唯一，只给文字版。
  const rest = tokens.slice(i);
  const color = rest[rest.length - 1];
  if (color !== undefined && !LOOKS_LENGTHISH.test(color) && !BOX_SHADOW_SKIP.has(color)) {
    const lengths = rest.slice(0, -1);
    if (lengths.every((t) => LOOKS_LENGTHISH.test(t))) {
      const reordered = [...leading, color, ...lengths].join(' ');
      out.push({
        ...mk(
          'vcss.boxShadowColorFirst',
          decl.valueStart,
          decl.valueEnd,
          msg.vcss.boxShadowColorFirst(),
          msg.vcss.boxShadowColorFirstFix(),
        ),
        edits: [{ start: decl.valueStart, end: decl.valueEnd, text: reordered }],
      });
      return;
    }
  }
  out.push(
    mk(
      'vcss.boxShadowColorFirst',
      decl.valueStart,
      decl.valueEnd,
      msg.vcss.boxShadowColorFirst(),
      msg.vcss.boxShadowColorFirstFix(),
    ),
  );
}

// ---------------------------------------------------------------------------
// 9. background-size: clip_then_cover（反编译器产物，非引擎关键字）
// ---------------------------------------------------------------------------

const CLIP_THEN_COVER_RE = /\bclip_then_cover\b/;

function checkClipThenCover(decl: VcssDeclaration, msg: Messages, out: Diagnostic[]): void {
  if (decl.property !== 'background-size') return;
  const m = CLIP_THEN_COVER_RE.exec(decl.value);
  if (!m) return;
  const start = decl.valueStart + m.index;
  const end = start + m[0].length;
  out.push(
    mk(
      'vcss.clipThenCover',
      start,
      end,
      msg.vcss.clipThenCover(),
      msg.vcss.clipThenCoverFix(),
    ),
  );
}

// ---------------------------------------------------------------------------
// 编排：遍历 doc.rules（含 children）、doc.keyframes（含其内层 rule 的
// ---------------------------------------------------------------------------
// 9.5 两个被 §10.1 与 §10.2 共用的判定工具
// ---------------------------------------------------------------------------

/**
 * 这个取值区间是否已被 §10.1 的某条**值级** warning 覆盖。
 *
 * 实现方式是直接把那几条规则跑一遍看它们报不报，而不是把它们的判据抄一份：
 * 抄一份必然漂移（改了 §10.1 那边、这边还按老判据让位，就又变成同一处两条
 * 诊断）。这三条都只做几次字符串比较，成本可以忽略。
 *
 * 两个消费方：vcss.unknownValue（§10.2 hint，见 checkUnknownValue 的 L2a）
 * 与 vcss.unknownDefine（§10.1 warning，见 checkUnknownDefine 开头）。
 */
function valueOwnedByWarningRule(decl: VcssDeclaration, msg: Messages): boolean {
  const probe: Diagnostic[] = [];
  checkPositionKeyword(decl, msg, probe);
  checkVisibilityHidden(decl, msg, probe);
  checkClipThenCover(decl, msg, probe);
  return probe.length > 0;
}

/**
 * 把声明里写的属性名归一成本扩展认识的那个拼写；认不出就原样返回。
 *
 * 大小写不敏感归一是**语料实证需要的**，不是想当然：两个构建合计 26 处 Valve
 * 自己出货的声明用了首字母大写的属性名（Width 6 / Padding 6 / Brightness 6 /
 * Margin-left 4 / Opacity 2 / Height 2），而 CSS 的属性名本来就是 ASCII
 * 大小写不敏感的。两张表（properties 与 webOnly）的键全部是小写，所以回退查
 * 一次小写形态即可；仍然先试精确匹配，避免将来表里出现非全小写的键时行为改变。
 *
 * webOnly 那一侧必须一起查，否则 `Display: flex` 会因为 display 不在
 * properties 段里而被当成「没见过的属性」，拿到一条 hint，而小写的
 * `display: flex` 拿到的是 §10.1 的 warning——同一条声明按大小写落到不同规则上。
 *
 * 认不出的名字**原样返回**，不做小写化：那样只会让 vcss.unknownProperty 的
 * 消息里出现用户没写过的拼写。props.has 走 Object.hasOwn、webOnlyFixFor 只信
 * 字符串返回值，因此 'Constructor' / 'ToString' 这类名字不会顺着原型链被
 * 误认成已知属性。
 */
function canonicalPropertyName(props: PropertyRegistry, name: string, msg: Messages): string {
  if (props.has(name) || webOnlyFixFor(name, props, msg) !== undefined) return name;
  const lower = name.toLowerCase();
  if (lower !== name && (props.has(lower) || webOnlyFixFor(lower, props, msg) !== undefined)) {
    return lower;
  }
  return name;
}

/**
 * 声明的归一视图：只替换 property 字段，偏移与取值原样带过去。
 *
 * ASCII 小写化不改变字符串长度，所以 propertyStart / propertyEnd 仍然精确圈住
 * 用户写的那段文本，诊断区间不受影响。
 *
 * **归一在遍历层做一次，全部规则拿到的都是规范拼写**——这是本文件唯一的归一点。
 * 早先的写法是让 §10.2 的两条规则各自在内部归一，结果只贯穿了一部分层次
 * （L2a 与 L3 仍拿原始 decl），同一条声明只因首字母大小写不同就在 warning ↔
 * hint 之间翻转。判定链有十几层、跨两个编排函数，逐层各归一一次迟早会漏；
 * 归一点只有一个才守得住「判定结果与属性名大小写无关」这条不变量，它由
 * test/unit/core/diagnostics/vcss-hint.test.ts 的表驱动测试逐条钉住。
 */
function withCanonicalProperty(
  decl: VcssDeclaration,
  props: PropertyRegistry,
  msg: Messages,
): VcssDeclaration {
  const canonical = canonicalPropertyName(props, decl.property, msg);
  return canonical === decl.property ? decl : { ...decl, property: canonical };
}

// children）、doc.defines，对每个声明 / 选择器 / 常量跑上面 9 条判据。
// ---------------------------------------------------------------------------

/**
 * 只下探一层 children，不做深度递归——与 src/core/vcss/context.ts 的
 * hoverTargetAt 用的是同一种遍历方式。VCSS 里唯一会产生嵌套块的地方是
 * @keyframes 内的 from / to / N% 百分比块，不会再往下嵌套第二层。
 */
function flattenRules(top: VcssRule): VcssRule[] {
  return [top, ...top.children];
}

export function checkVcssWarnings(
  doc: VcssDocument,
  props: PropertyRegistry,
  msg: Messages,
): Diagnostic[] {
  const out: Diagnostic[] = [];

  const topRules = [...doc.rules, ...doc.keyframes.map((k) => k.rule)];
  for (const top of topRules) {
    for (const rule of flattenRules(top)) {
      checkPseudoElement(rule, msg, out);
      for (const raw of rule.declarations) {
        const decl = withCanonicalProperty(raw, props, msg);
        checkWebOnlyProperty(decl, doc.text, props, msg, out);
        checkPositionKeyword(decl, msg, out);
        checkWebUnit(decl.value, decl.valueStart, msg, out);
        checkVisibilityHidden(decl, msg, out);
        checkCustomPropertyDeclare(decl, msg, out);
        checkCustomPropertyVarUsage(decl.value, decl.valueStart, msg, out);
        checkBoxShadowColorFirst(decl, msg, out);
        checkClipThenCover(decl, msg, out);
      }
    }
  }

  // @define 的值同样是「值文本」，同样可能被误写成 Web 语法（vw/vh/em/rem
  // 单位、var(--x) 引用）。@define 没有 property 字段，因此天然不参与
  // 上面那些按属性名精确匹配的规则（webOnlyProperty / positionKeyword /
  // visibilityHidden / boxShadowColorFirst / clipThenCover）。
  for (const def of doc.defines) {
    checkWebUnit(def.value, def.valueStart, msg, out);
    checkCustomPropertyVarUsage(def.value, def.valueStart, msg, out);
  }

  for (const kf of doc.keyframes) {
    checkKeyframesQuoting(kf, msg, out);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 10. 引用了索引中不存在的 @define 名（跨文件，规格 §10.1 第 10 条）
// ---------------------------------------------------------------------------
//
// 关键约束——defineRefs 是候选而非已解析引用（M3 的裁决，见
// src/core/index/symbols.ts 里 FileSymbols.defineRefs 的文档注释）：符号
// 抽取层无差别收集声明取值里的全部裸标识符，因为它在抽取阶段没有全局信息，
// 判断不了某个标识符是不是常量引用。若直接把这份候选表当成「未定义的引用」
// 来报，flow-children: right 的 right、overflow: squish 的 squish 这类合法
// 关键字取值会被全部当成错误。
//
// 判据必须反过来：先证明这个标识符确实处在「会引用常量的位置」，再查索引
// 里有没有定义，两者都成立才报。这里认定的位置是「声明的取值整体就是一个
// 裸标识符」——不含空白、括号、引号，box-shadow: 0px 2px 6px fill rgba(...)
// 这类多 token 的值天然不会落入这条判据，只有 box-shadow: shadowOffset; 这种
// 单 token 取值才会（语料里这类写法有 63 处，见 checkBoxShadowColorFirst 的
// 注释）。
//
// 光有「整体是裸标识符」还不够精确，两个构建、990 个文件的语料实测发现两类
// 会被误伤的合法写法，因此追加了下面几层排除：
//
// 1. 关键字域取值本身就登记在 vcss-properties.json 里，只是没做大小写归一
//    （horizontal-align: Left 这样的大写变体）——改成大小写不敏感比较解决。
// 2. 一批属性的取值域概念上是「行为模式选择器」（从一个小而封闭的关键字集合
//    里选一个），不是「测量值 / 颜色，偶尔用一两个关键字兜底」，因此从不会被
//    @define 引用；但 vcss-properties.json 对这几个属性的枚举有已知的实证
//    缺口（font-weight 缺 lighter/bolder，horizontal-align / vertical-align
//    / text-align 缺 middle / center_nopixelsnap，background-size 缺
//    cover，font-style 撞上语料里 italics 这个非标准拼写，
//    transition-property 的取值本身是另一个 CSS 属性名如 opacity，根本不是
//    常量引用）。补全这些属性的取值清单是 vcss.unknownValue（10.2，另一条
//    规则）的职责，不属于这里；本规则只需要知道「这些属性的裸标识符取值从
//    不是 @define 引用」，这个事实与取值清单是否补全无关，因此直接整体排除
//    这些属性，不依赖那条规则是否已经落地。
//
// 另外两类排除，与 vcss-properties.json 的完整度无关：
// - font-family：合法取值是任意字体名（语料里的 Stratum2、notosans 等），
//   本质是开放域，不存在可穷举的「已知取值」；穷举字体名不可行，直接排除
//   整条属性。
// - 一批 CSS 规范本身稳定、封闭的通用关键字（具名颜色、cursor 关键字、
//   方位关键字 top/right/bottom/left/center、all/auto/inherit/initial/
//   normal/unset 这类跨属性关键字）——这些是外部规范的稳定事实，不是
//   Panorama 专属知识，与 vcss-properties.json 是否收录它们无关，值得单独
//   维护一份而不是等着数据文件去补（数据文件的职责是 Panorama 专属属性，不是
//   转抄整份 CSS 规范）。
//
// 以上排除全部在两个构建、990 个文件的真实语料上验证过：排除后剩余 2535 个
// 候选，0 个未解析——含 box-shadow 的 100 个候选（63+ 处 @define 常量名全部
// 正确解析，规则没有因为排除面太宽而连这条唯一真正需要它的位置也一并丢掉）。
// 完整的排除推导过程见 task-4-report.md。

// CSS Color Module 标准具名颜色（147 个）+ transparent + currentcolor。这是
// 外部规范的稳定事实，不是猜测语料会出现哪些——color / background-color /
// wash-color / border-color 等属性的合法取值天然包含这整个词表。
const CSS_NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
  'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white',
  'whitesmoke', 'yellow', 'yellowgreen', 'transparent', 'currentcolor',
]);

// 跨属性通用、CSS 规范本身封闭的关键字词表：全局值（none/auto/inherit/...）、
// cursor 关键字、方位关键字。与 vcss-properties.json 的收录完整度无关。
const GLOBAL_VALUE_KEYWORDS = new Set([
  'none', 'inherit', 'initial', 'unset', 'auto', 'all', 'normal',
  'default', 'pointer', 'text', 'move', 'wait', 'help', 'progress', 'crosshair', 'not-allowed',
  'grab', 'grabbing', 'zoom-in', 'zoom-out',
  'top', 'right', 'bottom', 'left', 'center',
]);

// 取值域是「行为模式选择器」（封闭的小型关键字集合，从不被 @define 引用）
// 而非「测量值 / 颜色」的属性——见上方大注释第 2 点。语料实测验证过这份
// 名单排除后不再产生任何误报（详见 task-4-report.md）。
const KEYWORD_ONLY_PROPERTIES = new Set([
  'font-weight', 'font-style', 'horizontal-align', 'vertical-align', 'text-align',
  'background-size', 'transition-property',
]);

// 取值域本质开放（任意字体名），不存在可穷举的「已知取值」。
const OPEN_ENDED_VALUE_PROPERTIES = new Set(['font-family']);

// 整个取值必须恰好是一个裸标识符——不含空白、括号、引号、前导数字/符号。
const BARE_IDENTIFIER_RE = /^[A-Za-z_][\w-]*$/;

function isDefineReferenceCandidate(decl: VcssDeclaration, props: PropertyRegistry): boolean {
  const { property, value } = decl;
  // animation-name 的取值语法是关键帧名字，不是常量引用，由
  // checkAnimationNameKeyframes 单独处理。
  if (property === 'animation-name') return false;
  // 属性本身都不在注册表里（属性名打错，或 vcss-properties.json 尚未收录）
  // 时，不对它的取值下这条 warning 级结论。理由是规格 §10「分级看数据源
  // 可靠性」：注册表只有 105 个属性，认不出属性名时我们对这条声明的了解仅止于
  // 「没见过」——Task 5 的 vcss.unknownProperty 为此只给 hint；而 valuesOf()
  // 对未知属性返回空数组（见 data/properties.ts），会让下面「按属性查已知
  // 取值表」那一层排除静默失效，于是同一条声明反而拿到一条级别更高的
  // warning。对属性不确定、却对它的取值更确定，是反的。
  // 语料实测零命中（990 个文件里「属性不在注册表 + 取值是裸标识符」为 0 处），
  // 这条守卫不改变任何既有闸门数字，纯属防御。
  if (!props.has(property)) return false;
  if (KEYWORD_ONLY_PROPERTIES.has(property) || OPEN_ENDED_VALUE_PROPERTIES.has(property)) {
    return false;
  }
  if (!BARE_IDENTIFIER_RE.test(value)) return false;
  const lower = value.toLowerCase();
  if (GLOBAL_VALUE_KEYWORDS.has(lower) || CSS_NAMED_COLORS.has(lower)) return false;
  if (props.valuesOf(property).some((v) => v.toLowerCase() === lower)) return false;
  return true;
}

function checkUnknownDefine(
  decl: VcssDeclaration,
  props: PropertyRegistry,
  index: WorkspaceIndex,
  msg: Messages,
  out: Diagnostic[],
): void {
  // 该取值区间已被 §10.1 的值级 warning 占用时让位——visibility: hidden 与
  // position: absolute 的取值都不在各自属性的 values 里、属性也不在
  // KEYWORD_ONLY_PROPERTIES 里，于是它们会同时拿到一条 visibilityHidden /
  // positionKeyword 与一条 unknownDefine，落在同一个取值区间上；而后者的文案
  // 「hidden 不是工作区中已定义的 @define 常量」对规格 §10.1 亲自点名的标准
  // Web 写法是假阳性。§10.1 的定位是「能证明是错的」，同一处只留说得准的那条。
  // （语料里这两种写法各 0 处，闸门抓不到，只有单元测试钉得住。）
  if (valueOwnedByWarningRule(decl, msg)) return;
  if (!isDefineReferenceCandidate(decl, props)) return;
  const name = decl.value;
  if (index.defineDefinitions(name).length > 0) return;
  out.push(
    mk(
      'vcss.unknownDefine',
      decl.valueStart,
      decl.valueEnd,
      msg.vcss.unknownDefine(name),
      msg.vcss.unknownDefineFix(name),
    ),
  );
}

// ---------------------------------------------------------------------------
// 11. animation-name 引用了不存在的 @keyframes（跨文件，规格 §10.1 第 11 条）
// ---------------------------------------------------------------------------
//
// 与 unknownDefine 不同，这条不需要「候选 vs 引用」的判据体操：
// animation-name 的取值语法只可能是一个或多个（逗号分隔）关键帧名字，不存在
// 「这个词在这个位置到底是不是关键帧引用」的歧义——src/core/index/symbols.ts
// 的 keyframeRefs 抽取同样只发生在 animation-name 声明的取值里，说明这本来
// 就是一个无歧义的位置，不需要额外的排除清单。
//
// 逐段解析：可以是逗号分隔的多个动画名（真实语料如 hudgameicons.css 的
// animation-name: a, b, c;），每段可能带引号也可能不带。真实语料实测 259 处
// animation-name 全部不带引号（与本任务 brief 原文「animation-name 的值也
// 带引号」的说法相反，已用 grep 独立核实：全库 0 处带引号写法；带引号的分支
// 仍然保留，因为它是合法 VCSS 语法，不能假设它永远不出现）。
//
// 'none' 是 animation-name 自己的合法关键字（关闭动画；
// data/vcss-properties.json 的 animation-name.values 收录了它），不是关键帧
// 引用，必须排除——语料里 mainmenu.css 等 4 个位置有合法的
// animation-name: none;，不排除会被误报。
const ANIMATION_NAME_TOKEN_RE = /'([^']*)'|"([^"]*)"|[A-Za-z_][\w-]*/g;
const ANIMATION_NAME_NONE = 'none';

function checkAnimationNameKeyframes(
  decl: VcssDeclaration,
  index: WorkspaceIndex,
  msg: Messages,
  out: Diagnostic[],
): void {
  if (decl.property !== 'animation-name') return;
  ANIMATION_NAME_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANIMATION_NAME_TOKEN_RE.exec(decl.value)) !== null) {
    const quoted = m[1] ?? m[2];
    const name = quoted ?? m[0];
    // none 的比较大小写不敏感，与 isDefineReferenceCandidate 里其余词表比对
    // 一致（`animation-name: None;` 是合法写法，不是关键帧引用）。
    if (!name || name.toLowerCase() === ANIMATION_NAME_NONE) continue;
    if (index.keyframeDefinitions(name).length > 0) continue;
    const start = decl.valueStart + m.index + (quoted !== undefined ? 1 : 0);
    const end = start + name.length;
    out.push(
      mk(
        'vcss.unknownKeyframes',
        start,
        end,
        msg.vcss.unknownKeyframes(name),
        msg.vcss.unknownKeyframesFix(name),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 编排（跨文件）：与 checkVcssWarnings 分开成独立函数——只有调用方持有工作区
// 索引时才有意义调用（无索引时「找不到定义」这个判断根本不成立），由
// diagnoseVcss 按 ctx.index 是否存在决定要不要跑这一遍。
// ---------------------------------------------------------------------------
//
// 范围：只遍历 doc.rules 与 doc.keyframes[].rule，**刻意不含 doc.defines**。
// 这与同文件的 checkVcssWarnings（:354 起扫 doc.defines）不对称，是有意的，
// 不是遗漏：
//
// - `@define X: <裸标识符>;` 里的取值确实可能是对另一个 @define 的引用，
//   这是真实用法（两个构建共 44 处 @define 取值为裸标识符，其中
//   csgostyles.css:71-79 的 color-rarity-0 → color-rarity-default 等 9 条、
//   hudwinpanel_roundimpactscore.css:13 的 canvas-width → winPanelWidth
//   确为 @define 引用 @define）。
// - 但 unknownDefine 是 warning 级规则，它不误报的承重墙是
//   isDefineReferenceCandidate 的四层排除，而那四层里有三层都要靠**属性名**
//   （KEYWORD_ONLY / OPEN_ENDED / props.valuesOf / props.has）。@define 的
//   取值没有属性名可依托，四层里只剩全局关键字词表一层还成立。
// - 后果是立刻误报，语料里现成的两个反例：
//   `@define monospaceFont: notomono-regular;`（字体名，本该由
//   OPEN_ENDED_VALUE_PROPERTIES 那一层挡住，但这里没有 font-family 这个
//   属性名可查）与 `@define Radar_PanelHeight: fit-children;`（属性关键字，
//   本该由 props.valuesOf 那一层挡住，同理没有属性名可查）。
//
// 因此这条规则的范围只到「有属性名可依托的声明取值」为止。若将来要把
// @define 链纳进来，需要的是另一套判据（例如只在取值恰好命中某个已知
// @define 名字时才做拼写近似提示，或降到 hint 级），不是把 doc.defines
// 顺手加进下面这个循环。

export function checkVcssCrossFileWarnings(
  doc: VcssDocument,
  props: PropertyRegistry,
  index: WorkspaceIndex,
  msg: Messages,
): Diagnostic[] {
  const out: Diagnostic[] = [];

  const topRules = [...doc.rules, ...doc.keyframes.map((k) => k.rule)];
  for (const top of topRules) {
    for (const rule of flattenRules(top)) {
      for (const raw of rule.declarations) {
        const decl = withCanonicalProperty(raw, props, msg);
        checkUnknownDefine(decl, props, index, msg, out);
        checkAnimationNameKeyframes(decl, index, msg, out);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 12. 属性名不在人工清单里（规格 §10.2 第 1 条，hint）
// ---------------------------------------------------------------------------
//
// 级别只能到 hint，理由是规格 §5.2 自己写的已知缺陷：这份清单是从 225 个官方
// 样式表统计来的，「引擎实际支持的属性一定比它多」。不在清单里 ≠ 是错的。


/**
 * 取值里是否有**不在引号内**的左花括号。
 *
 * 这是「解析器正在从未闭合的块里恢复」的可靠信号：合法 VCSS 的声明取值不可能
 * 出现裸的 '{'。触发场景是上一个块少一个 '}' ——CSS 里最常见的手误，也正是
 * 规格给解析器定的「光标永远处在语法不完整的位置」这条硬约束覆盖的场景：
 *
 *     .outer {
 *         width: 1px;
 *     RadioButton:hover {        <- 少了上面那个 }
 *         color: #fff;
 *     }
 *
 * parseBlock 在块内部认声明时，停止符集合含 ':'，于是这一行会被切成
 * property = 'RadioButton'、value = 'hover { color: #fff'。此处的 property
 * 其实是个**选择器**（面板类型 + 伪类），拿去查属性清单必然误报。顶层不会
 * 有这个问题（顶层选择器一直扫到 '{' 才停），所以只有嵌套位置需要这道守卫。
 *
 * 必须跳过引号内部：语料里 52 处 background-image: url("file://{resources}/…")
 * 的取值确实含 '{'，但它在字符串里，是合法取值。
 */
function hasUnquotedBrace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < value.length && value[i] !== c) i++;
      continue;
    }
    if (c === '{') return true;
  }
  return false;
}

function checkUnknownProperty(
  decl: VcssDeclaration,
  props: PropertyRegistry,
  msg: Messages,
  out: Diagnostic[],
): void {
  const { property } = decl;
  // CSS 自定义属性由 vcss.customProperty（§10.1，warning）专管，区间完全相同
  // （都是 [propertyStart, propertyEnd)）。同一处不挂两条说同一个根因的诊断。
  if (property.startsWith('--')) return;
  // Web 独有属性由 vcss.webOnlyProperty（§10.1，warning）专管，同样是相同
  // 区间；那一条还带着替代写法，级别也更高，本条让位。
  if (webOnlyFixFor(property, props, msg) !== undefined) return;
  // 解析恢复产物：这里的 property 是选择器不是属性名（见 hasUnquotedBrace）
  if (hasUnquotedBrace(decl.value)) return;
  // 属性名已在遍历层归一成规范拼写（见 withCanonicalProperty），这里直接查表
  if (props.has(property)) return;
  out.push(
    mkHint(
      'vcss.unknownProperty',
      decl.propertyStart,
      decl.propertyEnd,
      msg.vcss.unknownProperty(property),
      msg.vcss.unknownPropertyFix(),
    ),
  );
}

// ---------------------------------------------------------------------------
// 13. 取值关键字不在已知集合里（规格 §10.2 第 2 条，hint，需要工作区索引）
// ---------------------------------------------------------------------------
//
// **不接 data/vcss-observed-values.json 观测层**（控制者 Ruling 12）。理由不是
// 规格 §5.3 那句「永远不作为诊断依据」的字面——观测层在这里本可以只做「命中则
// 静默」的压制、方向是安全的——而是它会让语料闸门自证：挖掘源是
// ${ARCHIVE}/20260829/panorama/styles（单构建 225 个样式表），而闸门跑两个构建
// 450 个。用观测层压制的话，「语料期望 N」这条断言对 20260829 那一半就是构造性
// 恒真（挖掘源与被测对象是同一批文件），等于把闸门关掉一半。将来若要接，前置
// 条件是先让两者不重叠（例如挖掘只用构建 A、闸门只跑构建 B）。
//
// 判定顺序如下，**顺序本身是承重的**：靠前的层会遮蔽靠后的层，写测试时每一层
// 都要挑一个不会被更靠前的层拦下的用例（见 test/unit/core/diagnostics/
// vcss-hint.test.ts 里逐层的注释）。
//
//   前置 B  整个取值恰好是一个裸标识符
//   前置 C  该属性在人工表里有非空取值枚举   → 同时覆盖前置 A：没有「已知集合」就
//                                        无从判断「不在集合里」
//   前置 D  transition-property 的取值域是属性名，不是关键字集合
//   L1      取值命中人工取值表（大小写不敏感）
//   L2      该位置由 §10.1 的值级规则专管    → 去重
//   L3      该位置由 vcss.unknownDefine 专管 → 去重
//   L4      CSS 具名颜色
//   L5      全局关键字词表
//   L6      工作区里存在同名 @define
//
// 前置 C + L3 合起来的效果，是这条规则**实际只对「取值域是封闭关键字集合」的
// 属性生效**（font-weight / font-style / horizontal-align / vertical-align /
// text-align / background-size）。这句话成立有个前提：属性名在进到这里之前
// 已经被 withCanonicalProperty 归一过。早先的实现只在本函数内部归一、且只
// 贯穿到前置 C/D 与 L1、L2b，L2a 与 L3 仍拿原始 decl，于是**任意属性的大小写
// 变体**都会漏到这里来（Overflow: bogusKeyword 拿 hint、overflow: bogusKeyword
// 拿 warning），这句结论当时是假的。归一提到遍历层做一次之后才重新成立。
//
// 其余属性的裸标识符取值，判据上更可能是 @define 引用，由 §10.1 的
// vcss.unknownDefine 承担——它有「索引里查不到定义」这个跨文件事实撑着，
// 比「不在人工取值表里」可靠得多，级别也因此是 warning。
//
// 「同一处只挂一条」这句话的适用范围要说清楚：它说的是 {unknownValue,
// unknownDefine} 这一对，以及 L2 让位的那几条 §10.1 值级规则——不是整个诊断
// 层的普遍性质（各规则之间是否重叠要逐对论证，别把这句读成全局保证）。

/** transition-property 的取值是另一个 CSS 属性名，不是关键字——见前置 D */
const PROPERTY_NAME_VALUED_PROPERTIES = new Set(['transition-property']);

function checkUnknownValue(
  decl: VcssDeclaration,
  props: PropertyRegistry,
  index: WorkspaceIndex,
  msg: Messages,
  out: Diagnostic[],
): void {
  const property = decl.property;

  // 前置 B：只判「整个取值就是一个关键字」。测量值、颜色、函数调用、多 token
  // 的复合取值都不是 §10.2 说的「取值关键字」，也没有可比的已知集合。
  const value = decl.value;
  if (!BARE_IDENTIFIER_RE.test(value)) return;

  // 前置 A（Ruling 13）+ 前置 C，合成一行：
  //
  // - 前置 A：属性本身都认不出来时，只报 vcss.unknownProperty，不再对它的取值
  //   另下一条结论——两条说的是同一个根因，且我们对属性的了解仅止于「没见过」，
  //   却对它的取值再下一条，与规格 §10「分级看数据源可靠性」相悖。与
  //   isDefineReferenceCandidate 里的同型守卫保持一致。
  // - 前置 C：人工表对这个属性根本没有取值枚举时，「不在已知集合里」这个判断
  //   无从成立（color / font-family / wash-color / cursor 等取值域开放或未整理
  //   的属性都落在这里）。
  //
  // 两者合成一行是**有意的**：props.valuesOf() 对未收录的属性返回空数组（见
  // data/properties.ts，get() 先过 Object.hasOwn），所以「属性不在清单里」在
  // 结构上必然蕴含「没有取值枚举」——单写一行 props.has() 守卫永远不可能被任何
  // 输入区分出来，是一条打不红的死线。合成之后 Ruling 13 那条测试
  //（colr: someval 只出一条 unknownProperty）由这一行独家保护，删掉它立刻变红。
  //
  // 属性名已在遍历层归一成规范拼写（见 withCanonicalProperty），这里直接查表。
  const known = props.valuesOf(property);
  if (known.length === 0) return;

  // 前置 D：transition-property 的 values 是 ["none"]（非空，前置 C 拦不住），
  // 但它的取值域其实是「另一个 CSS 属性名」，还可以逗号分隔、带 !immediate
  // 修饰。两个构建实测 2362 条声明 / 4112 个 token，按关键字判会多出 1100+
  // 处误报。校验「这个属性名存不存在」是另一条规则的事，不在 §10.2 的口径里。
  if (PROPERTY_NAME_VALUED_PROPERTIES.has(property)) return;

  const lower = value.toLowerCase();
  // L1：人工取值表。比较必须大小写不敏感——语料里 font-weight: Bold 3 处、
  // Medium 2 处、horizontal-align: Left 1 处、vertical-align: Bottom 3 处
  // （每构建），与 isDefineReferenceCandidate 里的比较口径一致。
  if (known.some((v) => v.toLowerCase() === lower)) return;

  // L2：该位置已由 §10.1 的值级 warning 覆盖（background-size:
  // clip_then_cover / visibility: hidden / position: absolute…）。
  if (valueOwnedByWarningRule(decl, msg)) return;
  // L2 的另一支：animation-name 的取值是关键帧名字，由 vcss.unknownKeyframes
  // 专管（它的 values 是 ["none"]，非空，前置 C 拦不住）。与
  // isDefineReferenceCandidate 的第一行同一个理由。
  if (property === 'animation-name') return;

  // L3：该位置是 @define 引用候选，由 §10.1 的 vcss.unknownDefine 专管——
  // 它要么在索引里解析到定义（那本来就不该报任何东西），要么报一条 warning。
  // 无论哪种，这里都不该再挂一条 hint。复用同一个谓词而不是抄判据，理由与
  // valueOwnedByWarningRule 相同。
  if (isDefineReferenceCandidate(decl, props)) return;

  // L4 / L5：CSS 规范本身稳定、封闭的两张词表（具名颜色、跨属性通用关键字）。
  // 与 isDefineReferenceCandidate 共用同两张表——它们是外部规范的事实，不是
  // Panorama 专属知识，data/vcss-properties.json 的职责里本来就不包含转抄
  // 整份 CSS 规范。L3 对这两类取值恒假（它自己就把它们排除掉了），因此这两层
  // 在这里是真正独立生效的，不是 L3 的重复。
  if (CSS_NAMED_COLORS.has(lower)) return;
  if (GLOBAL_VALUE_KEYWORDS.has(lower)) return;

  // L6：取值是工作区里某个 @define 的名字——真实的跨文件事实，不是弱可靠推测。
  // 前置 C + L3 之后仍然需要这一层：KEYWORD_ONLY_PROPERTIES 里的属性对 L3 恒假，
  // 而它们同样可以用常量取值（语料实测 72 处 background-size:
  // backgroundDotsSize 全靠这一层）。
  if (index.defineDefinitions(value).length > 0) return;

  out.push(
    mkHint(
      'vcss.unknownValue',
      decl.valueStart,
      decl.valueEnd,
      msg.vcss.unknownValue(value, property),
      msg.vcss.unknownValueFix(property, known),
    ),
  );
}

// ---------------------------------------------------------------------------
// 编排：§10.2 的两条 hint
//
// 拆成两个入口而不是并进上面的两个函数，是因为它们对索引的依赖不同：
// - unknownProperty 不需要索引，任何时候都能判。
// - unknownValue 需要索引：L6（取值是不是某个 @define 的名字）是它三层降噪里
//   最重的一层，没有索引时这层失效，语料实测会多出 72 处误报。判断的前提不
//   成立时整条跳过，与 unknownDefine / unknownKeyframes 的处理方式一致。
// ---------------------------------------------------------------------------

export function checkVcssHints(
  doc: VcssDocument,
  props: PropertyRegistry,
  msg: Messages,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const topRules = [...doc.rules, ...doc.keyframes.map((k) => k.rule)];
  for (const top of topRules) {
    for (const rule of flattenRules(top)) {
      for (const raw of rule.declarations) {
        const decl = withCanonicalProperty(raw, props, msg);
        checkUnknownProperty(decl, props, msg, out);
      }
    }
  }
  return out;
}

export function checkVcssCrossFileHints(
  doc: VcssDocument,
  props: PropertyRegistry,
  index: WorkspaceIndex,
  msg: Messages,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const topRules = [...doc.rules, ...doc.keyframes.map((k) => k.rule)];
  for (const top of topRules) {
    for (const rule of flattenRules(top)) {
      for (const raw of rule.declarations) {
        const decl = withCanonicalProperty(raw, props, msg);
        checkUnknownValue(decl, props, index, msg, out);
      }
    }
  }
  return out;
}
