import type { VxmlAttribute, VxmlDocument, VxmlElement } from '../vxml/ast';
import { CUSTOM_HUD_ALLOWED_STRUCTURAL, CUSTOM_HUD_WHITELIST, customHudAttributesOf } from '../mode';
import type { Diagnostic, FixEdit, RuleId } from './types';
import type { Messages } from '../i18n/types';
import { attributeSpan, judgeableAttributes, tagNameSettled } from './vxml';

/**
 * 规格 §10.3 的七条 CustomHudLayout 白名单 **error**。
 *
 * **仅在 `mode === 'customHudLayout'` 时生效，且只作用于 VXML。** 后半句是规格
 * §6.2 的明文：CustomHudLayout 对样式**没有任何限制**（官方原话「CSS 完全自定义，
 * VCSS 全套能力可用」），所以 `custom_game/` 下的 `.css` 与别处完全同等对待。
 * 落到代码上就是：这个文件只有一个入口、只吃 `VxmlDocument`，VCSS 那条链路
 * （`diagnoseVcss`）根本不认识它——不是靠一个 if 判掉的。
 *
 * **级别是 error 而非 warning**（规格 §10.3 首段）：白名单是引擎的硬限制，违反的
 * 后果不是「可能有问题」而是**这段 UI 确定不工作**。后果确定，级别就该到 error。
 *
 * **白名单表在 `src/core/mode.ts`（`CUSTOM_HUD_WHITELIST`），这里不抄第二份。**
 * 它同时供补全（`src/core/features/vxml.ts`）与本文件使用——两者必须一致，否则
 * 补全会主动引导用户写出诊断随即报错的代码（规格 §6.2 明说这一点）。
 *
 * **通则「信息不完整时不下结论」（Ruling 25，此前的 Ruling 23+24）**：任何语义
 * 规则都**不得对身份还没定下来的构造下结论**，那些位置由 `vxml.syntax` 独家负责。
 * 语法坏了，语义判断就建在沙子上——`<Panel width=10 />` 里 `width` 到底算不算一个
 * 属性都还没定，就断言「这个属性不在白名单里」是越界的；而 §10.3 的去重让本组
 * 优先，不让位的话那条「少了引号」的提示会被直接吃掉。
 *
 * **判据一份都不在本文件里**，两个谓词都从 `vxml.ts` 的通则一节引进来
 * （`tagNameSettled` / `judgeableAttributes`），与 §10.1 / §10.2 逐字同源：
 *
 * | 构造 | 判据 | 与 §10.1 的对应 |
 * |---|---|---|
 * | 元素的开始标签 | `tagNameSettled()` | `vxml.syntax`「开始标签缺 `>`」 |
 * | 单个属性 | `judgeableAttributes()` | `vxml.syntax`「属性值缺引号 / 缺右引号」 |
 *
 * **边界：不含「缺闭合标签」。** 那一种的构造身份**已经确定**（`<Frame>` 就是一个
 * Frame 元素，没有未定的余地），「Frame 在自定义 HUD 里不可用」这个结论不建在沙子
 * 上，按规格 §10.3「范围重叠时保留 10.3」照旧由本组优先。推广过去的代价实测过：
 * 自上而下新写一个文件时**每一层祖先**都处在「还没有闭合标签」的状态，推广之后整份
 * 文件在写完最后一个 `</…>` 之前一条 `hud.*` 都不会报——把 error 级的白名单规则做成
 * 了「写完才生效」。这条边界由 custom-hud.test.ts 里那条用例两个方向各钉一次。
 *
 * 判定顺序（**顺序本身是承重的**，靠前的层遮蔽靠后的层；测试里逐层标了号）：
 *
 *   标签 H-T0  root / styles / include        → 整个元素不判（标签与属性都不判）
 *        H-T1  身份未定（`!tagNameSettled`）  → 标签侧不报（通则）
 *        H-T2  scripts                        → hud.scripts
 *        H-T3  snippets / snippet / Frame     → hud.snippetsOrFrame
 *        H-T4  Panel / Label / Image / Button → 进属性侧
 *              其余一切                        → hud.panelNotAllowed，属性不判
 *
 *   属性 H-A0  身份未定的属性                 → 整个属性不判（通则：未闭合元素的
 *                                               末尾属性 + 语法坏掉的属性，与
 *                                               §10.1 / §10.2 共用 judgeableAttributes）
 *        H-A1  style                          → hud.inlineStyle
 *        H-A2  on*                            → hud.scripts
 *        H-A3  Button 上的 text               → hud.buttonText
 *        H-A4  不在该面板白名单里              → hud.attributeNotAllowed
 *        H-A5  取值里的 {d:} / {g:} / {t:}    → hud.binding（与 H-A1..A4 **并行**，
 *                                               区间落在取值里，与属性名不重叠）
 *
 * **语料对这七条一点活信号都没有**，且成因与 Ruling 16 那次不同：那次是压制层
 * 从被测语料自己挖的（跑了但必然不报），这次是 990 个文件**根本不进入这条代码
 * 路径**（全在 `layout/` 下，没有一个匹配 `custom_game/`）。闸门里那七个 0 是
 * 「没跑过」。真正的防线是 `test/unit/core/diagnostics/custom-hud.test.ts` 与
 * `dedup.test.ts`。
 */
function mkError(
  ruleId: RuleId,
  start: number,
  end: number,
  message: string,
  fix: string,
): Diagnostic {
  return { ruleId, severity: 'error', start, end, message, fix };
}

function* walkElements(els: readonly VxmlElement[]): Generator<VxmlElement> {
  for (const el of els) {
    yield el;
    yield* walkElements(el.children);
  }
}

/**
 * H-T0：严格模式下仍然合法的结构元素，整个元素不判。
 *
 * `root` 是文档骨架；`styles` 与它里面的 `include` 是 CustomHudLayout **引用
 * 样式表的唯一途径**——规格 §6.2 明确样式不受任何限制，把它们判成「不允许的
 * 面板类型」会让每一份合法的严格模式布局都平白挂三条 error。
 *
 * `styles` 这一项直接取自 `mode.ts` 的 `CUSTOM_HUD_ALLOWED_STRUCTURAL`（补全端
 * 用的是同一个常量），`root` / `include` 是它没覆盖的两个：前者不是「`<root>` 内
 * 可出现的结构元素」而是 `<root>` 自己，后者是 `<styles>` 的内容而不是 `<root>`
 * 的直接子元素——两者都不属于那个常量的语义，塞进去会改坏补全端的候选表。
 *
 * 属性侧同样不判：`<include src="…">` 的 `src` 是合法写法，而白名单表里根本没有
 * 「include 该有哪些属性」这一项，拿去判是无据可依（与 Ruling 17 同一条）。
 */
const ALLOWED_STRUCTURAL: ReadonlySet<string> = new Set([
  'root',
  'include',
  ...CUSTOM_HUD_ALLOWED_STRUCTURAL,
]);

/** H-T3：复用机制整体不可用（规格 §6.2「重复结构须逐个写出」） */
const SNIPPET_OR_FRAME: ReadonlySet<string> = new Set(['snippets', 'snippet', 'Frame']);

/**
 * H-A5：不对自定义内容开放的三种绑定前缀。只有 `{s:}`（服务端
 * `SetDialogVariableString` 填充的字符串变量）可用。
 *
 * 判据是**前缀本身**而不是整个绑定表达式：`{d:foo}` 与 `{d:` 都算，用户敲到一半
 * 也该看见——这条与「信息不完整时不下结论」不冲突，前缀四个字符一旦写出来，
 * 「用了哪一种绑定」这个事实就已经完整了，不存在还没写完的可能。
 */
const FORBIDDEN_BINDING_RE = /\{[dgt]:/g;

/** H-A2：任何 `on*` 事件属性都是脚本入口 —— 与 §6.2 的 `<scripts>` 同一条 */
const EVENT_ATTR_PREFIX = 'on';



function checkAttribute(
  text: string,
  el: VxmlElement,
  attr: VxmlAttribute,
  msg: Messages,
  out: Diagnostic[],
): void {
  // H-A0 的守卫不在这里，在调用点的 `judgeableAttributes()` 里——名字侧四层与
  // 取值侧的绑定扫描一起被挡掉，`hud.binding` 不会漏网。
  const allowed = customHudAttributesOf(el.tag);

  // H-A1：style（白名单里本来也没有它，但单独成条——提示要具体）
  if (attr.name === 'style') {
    out.push(
      mkError(
        'hud.inlineStyle',
        attr.nameStart,
        attr.nameEnd,
        msg.hud.inlineStyle(),
        msg.hud.inlineStyleFix(),
      ),
    );
  }
  // H-A2：on* 事件属性
  else if (attr.name.startsWith(EVENT_ATTR_PREFIX)) {
    out.push(
      mkError(
        'hud.scripts',
        attr.nameStart,
        attr.nameEnd,
        msg.hud.eventAttribute(attr.name),
        msg.hud.eventAttributeFix(),
      ),
    );
  }
  // H-A3：Button 上的 text —— 规格 §10.3 明确要它单独成条
  else if (el.tag === 'Button' && attr.name === 'text') {
    // 机械化修复（原子双编辑）：
    //  1) 删掉 text 属性；
    //  2) 自闭合的 `<Button … />` 展开成 `<Button …><Label text="X" /></Button>`
    //     （额外删掉那个 `/`），已配对的在开始标签后插入子 <Label>。
    // 两处必须一起上——只删属性会把按钮文字弄丢。
    const span = attributeSpan(text, attr);
    const edits: FixEdit[] = [{ start: span.start, end: span.end, text: '' }];
    const label = `<Label text="${attr.value ?? ''}" />`;
    if (el.selfClosing && el.openEnd >= 2) {
      // 从 '>' 向左找自闭合的 '/'（允许 `<Button … />` 的空格），连它前面的
      // 空白一起删——否则展开后留下 `<Button >` 这种尾巴
      let i = el.openEnd - 2;
      while (i > el.tagNameEnd && /[ \t]/.test(text[i])) i--;
      if (text[i] === '/') {
        let wsStart = i;
        while (wsStart > el.tagNameEnd && /[ \t]/.test(text[wsStart - 1])) wsStart--;
        edits.push({ start: wsStart, end: i + 1, text: '' });
        edits.push({ start: el.openEnd - 1, end: el.openEnd, text: `>${label}</Button>` });
      }
    } else if (el.openEnd >= 0) {
      edits.push({ start: el.openEnd, end: el.openEnd, text: label });
    }
    out.push({
      ...mkError(
        'hud.buttonText',
        attr.nameStart,
        attr.nameEnd,
        msg.hud.buttonText(),
        msg.hud.buttonTextFix(),
      ),
      ...(edits.length > 1 ? { edits } : {}),
    });
  }
  // H-A4：该面板白名单之外的属性（**逐面板**判定，不是四张表的并集）
  else if (!allowed.includes(attr.name)) {
    out.push(
      mkError(
        'hud.attributeNotAllowed',
        attr.nameStart,
        attr.nameEnd,
        msg.hud.attributeNotAllowed(el.tag, attr.name),
        msg.hud.attributeNotAllowedFix(el.tag, allowed.map((a) => `${a}=`).join(' ')),
      ),
    );
  }

  // H-A5：绑定前缀。与上面四层**并行**而不是互斥：区间落在取值里，与属性名
  // 不重叠，报的也是两件不同的事（属性本身不该出现 vs 取值里用了不开放的绑定）。
  if (attr.value === undefined || attr.valueStart === undefined) return;
  FORBIDDEN_BINDING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FORBIDDEN_BINDING_RE.exec(attr.value)) !== null) {
    const start = attr.valueStart + m.index;
    out.push({
      ...mkError(
        'hud.binding',
        start,
        start + m[0].length,
        msg.hud.binding(m[0]),
        msg.hud.bindingFix(),
      ),
      // 前缀置换：诊断区间恰好只盖 `{d:` 这四个字符，变量名原样保留
      edits: [{ start, end: start + m[0].length, text: '{s:' }],
    });
  }
}

function checkElement(
  el: VxmlElement,
  text: string,
  msg: Messages,
  out: Diagnostic[],
): void {
  // H-T0：结构元素两侧都不判
  if (ALLOWED_STRUCTURAL.has(el.tag)) return;

  if (!Object.hasOwn(CUSTOM_HUD_WHITELIST, el.tag)) {
    // H-T1（通则）：开始标签还没写完（缺 `>`）的元素，标签侧不报。
    // 用户敲 `<TextButt` 的中途就是这个状态，此刻断言「TextButt 不是允许的面板
    // 类型」是纯噪音；那一情形由 `vxml.syntax` 负责。
    //
    // **这里还有一层去重带来的额外理由**（brief 没写，实现时发现）：这条 error
    // 的区间与 `vxml.syntax` 的「开始标签缺 >」完全重合，而 §10.3 的去重让本组
    // 规则优先——不加这个守卫，用户看到的会是「TextButt 不是允许的面板类型」而
    // 不是「开始标签 <TextButt> 缺少 >」，后者才是他此刻要改的。守卫把这处交互
    // 消灭在源头，而不是给去重开特例。
    if (!tagNameSettled(el)) return;

    if (el.tag === 'scripts') {
      // H-T2
      out.push(
        mkError(
          'hud.scripts',
          el.tagNameStart,
          el.tagNameEnd,
          msg.hud.scripts(),
          msg.hud.scriptsFix(),
        ),
      );
      return;
    }
    if (SNIPPET_OR_FRAME.has(el.tag)) {
      // H-T3
      out.push(
        mkError(
          'hud.snippetsOrFrame',
          el.tagNameStart,
          el.tagNameEnd,
          msg.hud.snippetsOrFrame(el.tag),
          msg.hud.snippetsOrFrameFix(),
        ),
      );
      return;
    }
    // 其余一切：不在白名单里的面板类型
    out.push(
      mkError(
        'hud.panelNotAllowed',
        el.tagNameStart,
        el.tagNameEnd,
        msg.hud.panelNotAllowed(el.tag),
        msg.hud.panelNotAllowedFix(),
      ),
    );
    // 属性侧整个跳过：面板本身就不该存在，再逐个属性各报一条说的是同一件事；
    // 而且白名单表里没有「这个面板该有哪些属性」这一项，判也无据可依
    // （与 Ruling 17「标签不认识就不判它的属性」是同一条）。
    return;
  }

  // H-A0（通则）：身份未定的属性不判——未闭合元素的末尾属性（Ruling 22）与语法
  // 坏掉的属性（Ruling 24）合成同一个入口，与 §10.1 / §10.2 共用同一份判据
  for (const attr of judgeableAttributes(text, el)) checkAttribute(text, el, attr, msg, out);
}

// ---------------------------------------------------------------------------
// 编排（单文件）：白名单是写死的引擎约束，不需要工作区索引，也不需要
// panels.json——`CUSTOM_HUD_WHITELIST` 就是这七条规则的全部判据来源。
// 由 diagnoseVxml 在 ctx.mode === 'customHudLayout' 时调用。
// ---------------------------------------------------------------------------

export function checkCustomHudWhitelist(doc: VxmlDocument, msg: Messages): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const el of walkElements(doc.roots)) checkElement(el, doc.text, msg, out);
  return out;
}
