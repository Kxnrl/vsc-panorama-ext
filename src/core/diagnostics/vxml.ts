import type { VxmlAttribute, VxmlDocument, VxmlElement } from '../vxml/ast';
import type { WorkspaceIndex } from '../index/workspace-index';
import type { PanelRegistry } from '../data/panels';
import type { ObservedAttributes } from '../data/observed-attributes';
import type { Diagnostic, RuleId } from './types';
import type { Messages } from '../i18n/types';

/**
 * 本文件放 §10.1 的 `vxml.unknownTag`（warning）、§10.2 的
 * `vxml.unknownAttribute` 与 `vxml.unknownClass`（均为 hint），以及 §10.1 的四条
 * 结构 warning（`vxml.structure` / `vxml.rootOnlyNested` / `vxml.rootPanelId` /
 * `vxml.syntax`）与 §10.2 的 `vxml.duplicateId`（hint）。
 */
function mkWarning(
  ruleId: RuleId,
  start: number,
  end: number,
  message: string,
  fix: string,
): Diagnostic {
  return { ruleId, severity: 'warning', start, end, message, fix };
}

function mkHint(ruleId: RuleId, start: number, end: number, message: string, fix: string): Diagnostic {
  return { ruleId, severity: 'hint', start, end, message, fix };
}

/**
 * 整个属性的删除区间：从属性名起、到值的右引号止，并向左吞掉**一个**分隔空白
 * ——不吞的话 `<Panel  class=…` 会留下双空格。值未写完（unterminated / 无值）
 * 的属性只删名字段。rootPanelId 与 hud.buttonText 共用；放这里是因为区间
 * 语义与 judgeableAttributes 一样属于「对属性的结构性认知」。
 */
export function attributeSpan(text: string, attr: VxmlAttribute): { start: number; end: number } {
  const end =
    attr.value !== undefined && attr.valueStart !== undefined && !attr.unterminated
      ? attr.valueEnd! + 1 // 右引号
      : attr.nameEnd;
  let start = attr.nameStart;
  if (start > 0 && /[ \t]/.test(text[start - 1])) start -= 1;
  return { start, end };
}

function* walkElements(els: readonly VxmlElement[]): Generator<VxmlElement> {
  for (const el of els) {
    yield el;
    yield* walkElements(el.children);
  }
}

// ---------------------------------------------------------------------------
// 标签不在 panels.json 里（§10.1，warning）+ 属性不属于该面板（§10.2，hint）
// ---------------------------------------------------------------------------
//
// 两条规则写在同一个函数里，不是图省事：它们由 Ruling 17 的那一步**耦合**在一起
// ——「标签不认识」这个事实同时决定标签侧报不报、以及属性侧判不判。拆成两个独立
// 遍历的话，属性侧那个函数得把标签侧的判据再抄一遍，抄歪了就是 44 处误报。
//
// 判定顺序（D-M4-1 逐字 + Ruling 17 补的第一步），**顺序本身是承重的**：靠前的层
// 会遮蔽靠后的层，写测试时每一层都要挑一个不会被更靠前的层拦下的用例（见
// test/unit/core/diagnostics/vxml-tag-attr.test.ts 里逐层的标号与注释）。
//
//   标签 T-L0  结构标签整个不判（既不判标签也不判属性，见 STRUCTURAL_TAGS）
//        T-L1  panels.json 有            → 通过
//        T-L2  观测层有                  → 静默通过
//              都没有                    → vxml.unknownTag（warning）
//
//   属性 A-L1  标签不在 panels.json 里    → 整个元素的属性一律不判（Ruling 17）
//        A-L0  身份未定的属性（未闭合元素的末尾属性 / 语法坏掉的属性）→ 不判
//              （Ruling 22 + 24，统一走 judgeableAttributes，见通则一节）
//        A-L2  该面板属性集（含继承）有   → 通过
//        A-L3  data-* 或 on*             → 通过（规则层通用豁免，不查数据）
//        A-L4  观测层有                  → 静默通过
//              都没有                    → vxml.unknownAttribute（hint）
//
// **为什么属性这条是 hint 而不是规格 §10.1 原写的 warning**（D-M4-1，用户拍板）：
// XSD 的属性集被证明不完整——20260829 一个构建里就有 554 处合法属性不在集内，
// 领头的 `Label@value` 就有 337 次。规格 §10 自己的分级原则是「分级的依据是数据源
// 的可靠性」，数据源被证明不可靠，级别就该降。标签侧维持 warning（D-M4-2）：
// 缺口只有 6 种标签、观测层吸收后无噪音，且标签写错的后果确定得多。
//
// **观测层只用于压制，绝不用于产生**（规格 §5.3 的方向性约束，见
// src/core/data/observed-attributes.ts 的类注释）：T-L2 与 A-L4 都只有「命中则
// 静默」这一种用法，没有任何一处是「未命中则报」——那两条 push 的判据分别是
// 「panels.json 里没有」与「该面板属性集里没有」，与观测层无关。

/**
 * `<root>` 的骨架元素。它们不是面板，拿去查 `panels.json` 没有意义——`panels`
 * 表是从 XSD 的 complexType 生成的，而 XSD 把这几个骨架元素编码成
 * `Internal_Root*` 内部类型、生成器按 `Internal_` 前缀过滤掉了（规格 §5.1）。
 * 不排除的话每个布局的 `<root>` 都会挂一条 unknownTag。
 *
 * 属性侧同理：panels.json 里查不到「`snippet` 该有哪些属性」，`<snippet name>`
 * 与 `<include src>` 无从判定，整个元素跳过。
 *
 * **与挖掘脚本的口径必须逐字一致**（tools/mine-vxml-attributes.mts 的
 * STRUCTURAL_TAGS，以及 data/vxml-observed-attributes.json 的 excludedTags
 * 字段）：这里少一个，那个标签就会被报出来而观测层里没有它压制；这里多一个，
 * 真正的结构错误会被静默。
 *
 * 跳过的是**元素自己**，不是它的子树——`<snippet>` 里装的正是一堆真面板
 * （20 个 popup 都是这个形状），连子树一起丢会漏掉一大片。
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  'include',
  'root',
  'scripts',
  'snippet',
  'snippets',
  'styles',
]);

/**
 * A-L3：任何面板都可以带任意名字的自定义 `data-` 属性与 `on*` 事件处理器，
 * 这是**规则层的通用豁免**，不查数据文件——逐个枚举既没完没了（20260829 上
 * 已经 33 种 / 267 次），又会让数据文件随语料漂移。挖掘脚本在挖的时候就按同一
 * 组前缀排除（EXCLUDED_ATTR_PREFIXES），两侧口径一致。
 *
 * `on` 是裸前缀，因此 `once` / `online` 这类名字也会被豁免。这是**有意与挖掘
 * 口径保持一致**的取舍：改成「on + 已知事件名」会让豁免依赖一份我们并不掌握
 * 的事件清单（XSD 只列了 24 个 on* 属性，而语料里用到的远不止），收紧的代价是
 * 对真实事件处理器误报 hint，比放过几个 `on` 开头的普通属性名坏得多。
 */
const EXEMPT_ATTR_PREFIXES: readonly string[] = ['data-', 'on'];

// ===========================================================================
// 通则（Ruling 25）：信息不完整时不下结论
// ===========================================================================
//
// Ruling 13 / 17 / 19 / 22 / 23+24 是**同一条原则的五次应用**，每次都被逐例
// 应用在「当时正在做的那条规则」上：
//
//   13  属性不在人工清单里 → 不判它的取值          数据源不认识
//   17  标签不在 panels.json 里 → 不判它的属性      数据源不认识
//   19  标签没闭合 → 不判标签名                    输入不完整
//   22  元素没闭合 → 不判末尾属性                  输入不完整
//   23+24 语法有问题 → `hud.*` 一律不判            输入不合法
//
// **逐例打补丁的代价已经付过两次**：最终评审在 `vxml.unknownClass` /
// `vxml.unknownAttribute` / `vxml.structure` 里又找出三处该应用而没应用的，
// 本文件自己的 `vxml.rootPanelId` / `vxml.duplicateId` / `vxml.rootOnlyNested`
// 是第四、五、六处。所以判据在这里**只写一份**，全部规则一律走它。
//
// 通则展开成两条可执行的判据，区别在于「结论依赖的是什么」：
//
// 1. **身份类结论**（「这是什么标签 / 这是什么属性」）——依赖该构造本身的语法
//    完整。开始标签缺 `>`、属性缺引号、正在敲的末尾属性，身份都还没定下来，
//    此刻下结论就是建在沙子上。对应 `tagNameSettled()` 与 `judgeableAttributes()`。
//
// 2. **缺失类结论**（「这里面没有 X」）——依赖该容器的内容已经写完。容器还没
//    收尾（缺 `>` 或缺闭合标签）时，「没有 X」这件事根本还没发生完。对应
//    `contentSettled()`。
//
// **Ruling 24 那处收窄由这个分法直接推出，不是特例**：「缺闭合标签」时构造的
// 身份**已经确定**（`<Frame>` 就是一个 Frame），所以第 1 条不管它——否则自上而下
// 写文件时每一层祖先都处在未闭合状态，整份文件在敲完最后一个 `</…>` 之前一条
// 规则都不报，等于把 error 级白名单做成「写完才生效」。它只落在第 2 条上：
// `<root>` 还没闭合就断言「下面没有根面板」，缺的恰恰是还没写完的那部分。
//
// 横向闸门在 test/unit/core/diagnostics/incomplete-input.test.ts：它不认识任何
// 一条具体规则，只断言「身份未定的区间上除 `vxml.syntax` 外一条诊断都没有」，
// 因此**将来新增的规则忘了走守卫时会自动变红**，不需要有人记得回头重扫。

/**
 * 标签名的身份已经定下来了（开始标签写完了 `>`）。
 *
 * Ruling 19 / 23：敲 `<Lab` 的中途就是未闭合状态，此刻断言「Lab 不是已知面板
 * 类型」「Lab 在自定义 HUD 里不允许」都是纯噪音，那个位置由 `vxml.syntax` 独家
 * 负责。判据只看 `el.unclosed`，**不含「缺闭合标签」**——见上方通则第 1 条的说明。
 */
export function tagNameSettled(el: VxmlElement): boolean {
  return !el.unclosed;
}

/**
 * 可以拿去做**身份类判断**的属性：身份已经定下来、语法也没坏的那些。
 *
 * 两条来源都是通则第 1 条的实例，合成一个函数是有意的——两边各写一份正是
 * Ruling 24 点名要避免的分叉：
 *
 * - **Ruling 22**：元素未闭合（开始标签缺 `>`）时跳过**最后一个**属性。来由是
 *   T8 评审实测的噪音：敲 `<Panel cla` 时 `cla` 立刻被报成 `vxml.unknownAttribute`
 *   （`clas` 在观测层里、`cla` 不在，A-L4 拦不住）。不是「未闭合元素的属性全部
 *   不判」：`<Panel foo="1" bar="2" cla` 里 `foo` / `bar` 已经写完整了，对它们下
 *   结论有依据，**正在被敲的只有最后那个 token**。
 * - **Ruling 24**：语法坏掉的属性（缺引号 / 缺右引号 / 只写到 `name=`）整个跳过。
 *   `<Panel width=10 />` 里 `width` 到底算不算一个属性都还没定，就断言「这个属性
 *   不在白名单里」是越界的。判据取自 `vxml.syntax` 自己那个函数（见
 *   `attributeSyntaxBroken`），**分叉在结构上不可能发生**。
 *
 * 跳过的是**整个属性**（名字与取值一起），不只是属性名：`vxml.unknownClass` /
 * `vxml.duplicateId` / `hud.binding` 把区间挂在取值里，只挡名字侧它们照样会对
 * 一段还没写完的垃圾文本下结论——最终评审实测到的正是这一种
 * （`<Panel class="abc>` 报出「类名 `abc></Panel></root>` 找不到定义」）。
 *
 * 导出给 `custom-hud.ts` 共用（§10.3 的属性侧规则是 error 级，噪音代价更高）。
 */
export function judgeableAttributes(text: string, el: VxmlElement): readonly VxmlAttribute[] {
  const settled = el.unclosed ? el.attributes.slice(0, -1) : el.attributes;
  return settled.filter((a) => !attributeSyntaxBroken(text, a));
}

/**
 * 这个元素的**内容已经写完**（开始标签收了 `>`，元素本身也由自闭合或闭合标签
 * 收尾）。
 *
 * 通则第 2 条**唯一**的消费方式：只用来挡「里面没有 X」这一类缺失类结论，绝不
 * 用来挡身份类结论——后者会退化成 Ruling 24 收窄里论证过的那个坏结果。
 */
export function contentSettled(text: string, el: VxmlElement): boolean {
  return !unterminated(text, el);
}

function checkTagAndAttributes(
  el: VxmlElement,
  text: string,
  panels: PanelRegistry,
  observed: ObservedAttributes,
  msg: Messages,
  out: Diagnostic[],
): void {
  // T-L0：结构标签两侧都不判
  if (STRUCTURAL_TAGS.has(el.tag)) return;

  // T-L1 / T-L2 / A-L1
  if (!panels.has(el.tag)) {
    // T-L2：观测层命中则静默通过（D-M4-2：panels.json 少收了 6 种真实标签）
    // T-L2b（Ruling 19，Task 8 补）：开始标签还没写完（缺 `>`）的元素不报这条
    // ——那一情形由 `vxml.syntax` 独家负责。T7 评审实测：编辑中途的半截标签会
    // 立刻挂一条 warning（`<root><Lab` → `unknownTag[Lab:warning]`），而
    // `vxml.syntax` 会在**同一个元素**上再报一条，同一根因两条诊断。
    //
    // 规格把「容错」列为解析器的硬约束，理由正是「光标永远处在语法不完整的
    // 位置」；用户敲 `<Lab` 的中途就是未闭合状态，此刻断言「Lab 不是已知面板
    // 类型」是纯噪音。这与 Ruling 13（属性不认识就不判取值）、Ruling 17（标签
    // 不认识就不判属性）是同一条原则的第三次应用：**信息不完整时不下结论**。
    //
    // 守卫只加在这一条 push 上，不写成函数开头的 `if (el.unclosed) return`：
    // 后者会顺带改掉 `vxml.unknownAttribute` 对「未闭合的**已知**标签」的行为，
    // 而 Ruling 19 没有授权那个改动。
    if (!observed.hasTag(el.tag) && tagNameSettled(el)) {
      out.push(
        mkWarning(
          'vxml.unknownTag',
          el.tagNameStart,
          el.tagNameEnd,
          msg.vxml.unknownTag(el.tag),
          msg.vxml.unknownTagFix(),
        ),
      );
    }
    // A-L1（Ruling 17）：标签不认识就不对它的属性下结论。理由与 Ruling 13
    // （属性不在人工清单里就不判它的取值）是同一条，都是规格 §10「分级看数据源
    // 可靠性」的直接推论：
    //
    // 1. 我们对这个标签**一无所知**——panels.json 里没有它，就没有「它该有哪些
    //    属性」这份清单，判据根本不存在。让观测层去收未知标签的属性，等于断言
    //    「这些属性属于这个标签」，没有任何依据做这个关联；
    // 2. 标签本身已经由上面那条 warning 报了（或被观测层判定为真实存在）。再对
    //    它的每个属性各报一条 hint，是同一个根因挂多条诊断。
    //
    // 语料实测：不加这一步，那 6 种未知标签上的属性会被报成 **44** 处 hint
    // （20260829 有 23、20260716 有 21），其中还包括 `id` / `class` / `style`
    // 这种**任何面板都合法**的属性——因为未知标签的属性集是空的。
    //
    // 守卫的判据必须是「不在 panels.json 里」，不能写成「刚报了 unknownTag」：
    // 那 44 处的标签全都在观测层里、一条 unknownTag 都不报，按后者写法照样会漏。
    return;
  }

  for (const attr of judgeableAttributes(text, el)) {
    // A-L2：该面板属性集，含继承（PanelRegistry.attributesOf 把 sets 并起来）
    if (panels.hasAttribute(el.tag, attr.name)) continue;
    // A-L3：data-* / on*
    if (EXEMPT_ATTR_PREFIXES.some((p) => attr.name.startsWith(p))) continue;
    // A-L4：观测层命中则静默通过。按 (面板, 属性) 分域查，不是塌成一个扁平的
    // 属性名集合——`value` 在 Label 上观测到过、在 Panel 上没有，塌平之后
    // 「属性用错面板」这类真错误会被一并压掉。
    if (observed.has(el.tag, attr.name)) continue;

    out.push(
      mkHint(
        'vxml.unknownAttribute',
        attr.nameStart,
        attr.nameEnd,
        msg.vxml.unknownAttribute(attr.name, el.tag),
        msg.vxml.unknownAttributeFix(el.tag),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 编排（单文件）：这两条规则不需要工作区索引——「标签在不在 panels.json 里」
// 与「属性在不在该面板属性集里」都是单文件视野下就能下的判断，与 unknownClass
// 那种「定义在别的文件里」的跨文件事实不同。因此 diagnoseVxml 无条件跑这一遍，
// 不放进 ctx.index 的分支里。
// ---------------------------------------------------------------------------

export function checkVxmlTagsAndAttributes(
  doc: VxmlDocument,
  panels: PanelRegistry,
  observed: ObservedAttributes,
  msg: Messages,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const el of walkElements(doc.roots)) {
    checkTagAndAttributes(el, doc.text, panels, observed, msg, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// class="x" 中的 x 在索引里找不到定义（跨文件，规格 §10.2）
// ---------------------------------------------------------------------------
//
// 与 VCSS 的 defineRefs 不同，这里不需要「候选 vs 引用」的判据体操：VXML 的
// class 属性只可能装空白分隔的类名列表，不存在「这个词在这个位置到底是不是
// 类名引用」的歧义——没有 flow-children: right 那种同一个词在同一个位置可能
// 是关键字也可能是引用的情况。与 src/core/index/symbols.ts 的 symbolsOfVxml
// classRefs 抽取用的是同一条正则（`/[^\s]+/g`），后者对此已有同样的判断。
const CLASS_TOKEN_RE = /[^\s]+/g;

function checkUnknownClass(
  el: VxmlElement,
  text: string,
  index: WorkspaceIndex,
  msg: Messages,
  out: Diagnostic[],
): void {
  // 通则（Ruling 25）：身份未定的属性整个不判。这条规则把区间挂在**取值里**，
  // 所以「语法坏了就别下结论」对它尤其要紧——`<Panel class="abc>` 少个右引号时，
  // 解析器把取值一路截到行尾，不挡的话波浪线会盖住 `abc></Panel></root>` 19 个
  // 字符，消息还把标签名当类名念出来（最终评审 I-2 的实测症状）。
  for (const attr of judgeableAttributes(text, el)) {
    if (attr.name !== 'class' || attr.value === undefined || attr.valueStart === undefined) continue;
    const base = attr.valueStart;
    CLASS_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLASS_TOKEN_RE.exec(attr.value)) !== null) {
      const name = m[0];
      if (index.classDefinitions(name).length > 0) continue;
      const start = base + m.index;
      out.push(
        mkHint(
          'vxml.unknownClass',
          start,
          start + name.length,
          msg.vxml.unknownClass(name),
          msg.vxml.unknownClassFix(),
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 编排（跨文件）：只有调用方持有工作区索引时才有意义调用（无索引时「找不到
// 定义」这个判断根本不成立），由 diagnoseVxml 按 ctx.index 是否存在决定要不
// 要跑这一遍。
// ---------------------------------------------------------------------------

export function checkVxmlCrossFileWarnings(
  doc: VxmlDocument,
  index: WorkspaceIndex,
  msg: Messages,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const el of walkElements(doc.roots)) {
    checkUnknownClass(el, doc.text, index, msg, out);
  }
  return out;
}

// ===========================================================================
// §10.1 的四条结构 warning + §10.2 的同作用域 id 重复（hint）——Task 8
// ===========================================================================
//
// 这一段的全部判据都挂在同一件事上：**谁是根面板**。定义只有一句，但它是本
// 任务唯一一处「写错了语料上会炸 42 处、单元测试却可能全绿」的地方：
//
//   根面板 = `<root>` 的**直接子元素**里，排除 `<styles>` / `<scripts>` /
//   `<snippets>` 之后剩下的那一个（评审 Minor 1 之后另排除 `<include>` /
//   `<snippet>` / 嵌套的 `<root>`，见 MISPLACED_UNDER_ROOT）。
//
// **不是**「文档里第一个面板元素」。20 个 popup 的真实形态是
// `<styles>` → `<scripts>` → `<snippets>`（里面装着 `<Panel>` 等真面板）→
// `<PopupCustomLayout>`，朴素写法会把 snippet 模板里的 `<Panel>` 当成根面板，
// 于是真正的根面板 `PopupCustomLayout`（`rootOnly: true`）被判成嵌套位置。
// 控制者写计划时的粗扫就是这么报出「rootOnly 嵌套 21 次」的，逐例核查后全部
// 是误报；本任务用真解析器复量：朴素定义两构建合计 **42** 处误报，正确定义
// **0** 处。钉住这一点的是 vxml-structure.test.ts 里那条真实 popup 用例。

/**
 * `<root>` 下的骨架元素，**数组顺序就是它们的合法先后顺序**（顺序判定直接
 * 用下标做 rank，改这个数组即改判据）。540 个真实布局实测只出现四种排列：
 * `styles>scripts` 194、`styles>scripts>snippets` 184、`styles` 130、
 * `styles>snippets` 30（另有 2 个文件一个骨架元素都没有）——全部与这个顺序
 * 相容，没有一处重复或倒置。
 *
 * 骨架之外还有三个**同样不可能是根面板**的结构标签，见 MISPLACED_UNDER_ROOT。
 */
const SKELETON_TAGS: readonly string[] = ['styles', 'scripts', 'snippets'];
const SKELETON_RANK: ReadonlyMap<string, number> = new Map(SKELETON_TAGS.map((t, i) => [t, i]));

/**
 * 出现在 `<root>` 直接子元素位置上就是**它自己位置错了**的结构标签，各带自己的
 * 消息与替代写法。
 *
 * 交付时它们不在任何排除集合里，于是被当成根面板参与计数，后果是报点落在**无辜
 * 的真根面板**上、并给出一条南辕北辙的 fix（T8 评审 Minor 1 实测：
 * `<root><include src="a" /><Panel /></root>` 报的是「<Panel> 是多出来的，把它挪
 * 进第一个根面板里」——而那个「第一个根面板」正是 `<include>` 自己）。
 *
 * 语料 540 个布局对这三者零命中：`<root>` 元素数恒为 1（所以没有嵌套 root），
 * 排除骨架后的根面板数恒为 1 且没有一个是 include/snippet（否则闸门的
 * `vxml.structure: 0` 会立刻变红）。所以这不是回归风险，是新写文件时的体验缺陷。
 *
 * **标签清单是这里唯一的真源。** 它有两个消费方，性质不同：
 *
 * - `isRootPanelCandidate` 只要**键集**——那是纯结构事实，与文案无关，
 *   不该为此被迫拿到一个 `Messages`；
 * - `checkStructure` 要**每个标签各自的 message / fix**，那必须等 locale 到位。
 *
 * 两者都从这一个数组派生。本地化改造中途曾经把键集另抄一份写成独立的 Set，
 * 那样加第四个标签时漏抄一边就会让 `isRootPanelCandidate` 把它当成根面板候选，
 * 根面板计数随之出错——而今天只有三个标签，没有任何测试会红。现在的写法里，
 * `Record<MisplacedTag, …>` 让漏抄在 tsc 阶段就报错。
 */
const MISPLACED_UNDER_ROOT_TAGS = ['include', 'snippet', 'root'] as const;
type MisplacedTag = (typeof MISPLACED_UNDER_ROOT_TAGS)[number];

const MISPLACED_UNDER_ROOT_TAG_SET: ReadonlySet<string> = new Set(MISPLACED_UNDER_ROOT_TAGS);

/**
 * 位置错了的结构标签 -> 它自己的 message / fix。
 *
 * 此前这里是模块级常量表。常量在 import 时求值，那时还没有 locale——本地化改造
 * 后必须改成函数。项目里同类的还有 `features/vxml.ts` 的绑定说明表。
 *
 * 调用方要把结果**提到循环外**：每次迭代重建一遍 Map 没有意义。
 */
function misplacedUnderRoot(
  msg: Messages,
): ReadonlyMap<string, { readonly message: string; readonly fix: string }> {
  const text: Readonly<Record<MisplacedTag, { readonly message: string; readonly fix: string }>> = {
    include: { message: msg.vxml.includeUnderRoot(), fix: msg.vxml.includeUnderRootFix() },
    snippet: { message: msg.vxml.snippetUnderRoot(), fix: msg.vxml.snippetUnderRootFix() },
    root: { message: msg.vxml.rootUnderRoot(), fix: msg.vxml.rootUnderRootFix() },
  };
  return new Map(MISPLACED_UNDER_ROOT_TAGS.map((t) => [t, text[t]]));
}

/** 能不能当根面板：骨架与「位置错了的结构标签」都不能 */
function isRootPanelCandidate(el: VxmlElement): boolean {
  return !SKELETON_RANK.has(el.tag) && !MISPLACED_UNDER_ROOT_TAG_SET.has(el.tag);
}

interface RootShape {
  /** 全部**顶层** `<root>`（正常布局恰好一个） */
  readonly roots: readonly VxmlElement[];
  /** 顶层第一个 `<root>`；没有则 undefined */
  readonly root?: VxmlElement;
  /** 第一个 `<root>` 的直接子元素里排除结构标签之后剩下的——正常布局恰好一个 */
  readonly rootPanels: readonly VxmlElement[];
  /**
   * **所有**顶层 `<root>` 的根位置元素。只用来**压制**（rootOnlyNested 放行），
   * 不用来报点。
   *
   * 与 rootPanels 分开是 T8 评审 Minor 5：只认第一个 `<root>` 时，
   * `<root><Panel /></root><root><ContextMenu /></root>` 会说 ContextMenu
   * 「嵌套在其他面板里」——它明明就在一个 `<root>` 的根位置上，同一个根因
   * （多了一个 `<root>`）挂了两条诊断。多一个 `<root>` 时哪棵才是真的无从判断，
   * 所以这里只放宽压制、不追加指控（与「没有 `<root>` 时整条跳过」同一条原则）。
   */
  readonly rootPositions: ReadonlySet<VxmlElement>;
}

function rootShapeOf(doc: VxmlDocument): RootShape {
  const roots = doc.roots.filter((e) => e.tag === 'root');
  const root = roots[0];
  if (!root) return { roots, rootPanels: [], rootPositions: new Set() };
  return {
    roots,
    root,
    rootPanels: root.children.filter(isRootPanelCandidate),
    rootPositions: new Set(roots.flatMap((r) => r.children).filter(isRootPanelCandidate)),
  };
}

// ---------------------------------------------------------------------------
// vxml.structure（warning）
// ---------------------------------------------------------------------------

function checkStructure(
  doc: VxmlDocument,
  shape: RootShape,
  msg: Messages,
  out: Diagnostic[],
): void {
  // 空文档（或只有注释/处理指令）不判：新建一个文件、还没敲任何东西的状态，
  // 报「缺 <root>」是纯噪音。与 Ruling 19 同一条原则。
  if (doc.roots.length === 0) return;

  const text = doc.text;
  const roots = shape.roots;
  if (roots.length === 0) {
    const first = doc.roots[0];
    // 通则第 2 条（Ruling 25）：**缺失类结论**要求容器的内容已经写完。文档里
    // 还有没收尾的顶层元素时（敲到 `<Pane` 的那一刻）不判——「文档里没有
    // `<root>`」这件事此刻还没发生完，而那个位置已经由 `vxml.syntax` 报了
    // 「开始标签缺 >」。最终评审 M-2 实测的双报正是这一种。
    //
    // 内容收尾之后照报：`<Zzzz></Zzzz>` 仍然会同时拿到「文档缺少 <root>」与
    // 「Zzzz 不是已知的面板类型」——那两条各有充分依据、说的是两件事，不是双报。
    if (doc.roots.some((e) => !contentSettled(text, e))) return;
    out.push(
      mkWarning(
        'vxml.structure',
        first.tagNameStart,
        first.tagNameEnd,
        msg.vxml.missingRoot(),
        msg.vxml.missingRootFix(),
      ),
    );
    return;
  }
  for (const extra of roots.slice(1)) {
    out.push(
      mkWarning(
        'vxml.structure',
        extra.tagNameStart,
        extra.tagNameEnd,
        msg.vxml.duplicateRoot(),
        msg.vxml.duplicateRootFix(),
      ),
    );
  }

  const root = roots[0];

  // 骨架元素：重复 / 顺序 / 出现在根面板之后。三者互斥地各报一条——同一个
  // 元素挂两条说的是同一件事（Task 5 评审 I-2 修过的同型问题）。
  let maxRank = -1;
  const seenSkeleton = new Set<string>();
  let firstPanel: VxmlElement | undefined;
  // 建一次就够：表的内容只取决于 locale，与遍历到哪个子元素无关。
  const misplacedTable = misplacedUnderRoot(msg);
  for (const child of root.children) {
    // 位置错了的结构标签：报在**它自己**身上，并且不参与根面板计数、
    // 不影响骨架顺序判定（T8 评审 Minor 1）。
    const misplaced = misplacedTable.get(child.tag);
    if (misplaced) {
      out.push(
        mkWarning(
          'vxml.structure',
          child.tagNameStart,
          child.tagNameEnd,
          misplaced.message,
          misplaced.fix,
        ),
      );
      continue;
    }
    const rank = SKELETON_RANK.get(child.tag);
    if (rank === undefined) {
      firstPanel ??= child;
      continue;
    }
    const at = (message: string, fix: string) =>
      out.push(mkWarning('vxml.structure', child.tagNameStart, child.tagNameEnd, message, fix));

    if (firstPanel) {
      at(
        msg.vxml.skeletonAfterPanel(child.tag, firstPanel.tag),
        msg.vxml.skeletonAfterPanelFix(child.tag, firstPanel.tag),
      );
      continue;
    }
    if (seenSkeleton.has(child.tag)) {
      at(
        msg.vxml.skeletonDuplicate(child.tag),
        msg.vxml.skeletonDuplicateFix(child.tag),
      );
      continue;
    }
    seenSkeleton.add(child.tag);
    if (rank < maxRank) {
      at(
        msg.vxml.skeletonOutOfOrder(child.tag, SKELETON_TAGS[maxRank]),
        msg.vxml.skeletonOutOfOrderFix(SKELETON_TAGS.map((t) => `<${t}>`).join(' → ')),
      );
      continue;
    }
    maxRank = rank;
  }

  // 根面板数量。**缺失类结论**（通则第 2 条）：`<root>` 的内容还没写完时不判
  // ——开始标签缺 `>`（那一刻 children 必然是空的）或者 `</root>` 还没敲上，
  // 「下面有没有根面板」这件事都还没发生完，报出来是纯噪音；那个位置已经由
  // `vxml.syntax` 报了。最终评审 M-2 在 2806 个变异用例里扫到的 10 次重叠，
  // 主要形态就是把一份真实布局截断在中途、`root` 上同时挂两条 warning。
  //
  // 注意这里**只挡缺失类结论**：下面那条「多出来的根面板」是存在类结论，
  // 依据已经在场，`<root>` 收没收尾都照报（收窄见通则一节）。
  if (shape.rootPanels.length === 0) {
    if (!contentSettled(text, root)) return;
    out.push(
      mkWarning(
        'vxml.structure',
        root.tagNameStart,
        root.tagNameEnd,
        msg.vxml.missingRootPanel(),
        msg.vxml.missingRootPanelFix(),
      ),
    );
    return;
  }
  for (const extra of shape.rootPanels.slice(1)) {
    out.push(
      mkWarning(
        'vxml.structure',
        extra.tagNameStart,
        extra.tagNameEnd,
        msg.vxml.extraRootPanel(extra.tag),
        msg.vxml.extraRootPanelFix(extra.tag),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// vxml.rootPanelId（warning）—— 规格 §10.1 里唯一一条明说「必须硬编码」的
// ---------------------------------------------------------------------------
//
// 这条**无法从 XSD 推导**：根位置引用的是与普通面板相同的类型，它们都从基础
// `Panel` 继承了 `id`，schema 层完全合法（`panels.hasAttribute('Panel','id')`
// 为真，测试里钉了），但引擎不接受。所以 `vxml.unknownAttribute` 永远不会命中
// 它，只能在规则层写死。M1 期间已在两个构建全部 540 个布局上验证：根面板带
// `id` 的数量为 0，本任务用真解析器复量一致。

function checkRootPanelId(
  text: string,
  shape: RootShape,
  msg: Messages,
  out: Diagnostic[],
): void {
  for (const panel of shape.rootPanels) {
    // 通则（Ruling 25）：身份未定的属性不判。`<root><Panel id="a></root>` 缺个
    // 右引号时，`id` 这个 token 上原本会同时挂 `vxml.rootPanelId` 与
    // `vxml.syntax` 两条 warning——那是最终评审 I-2 归在一起的同型第二处。
    const id = judgeableAttributes(text, panel).find((a) => a.name === 'id');
    if (!id) continue;
    // 机械修复照 fix 文案办：把挂钩改成 class（名字保留），而不是删掉属性。
    // 元素已有 class 时不能产出第二个 class 属性（非法 XML）——并入既有取值。
    const attrs = judgeableAttributes(text, panel);
    const classAttr = attrs.find((a) => a.name === 'class' && a !== id && !a.unterminated);
    const span = attributeSpan(text, id);
    const idVal = id.value;
    let edits;
    if (
      classAttr &&
      classAttr.valueStart !== undefined &&
      classAttr.valueEnd !== undefined &&
      classAttr.value !== undefined
    ) {
      // 已有 class：并入既有取值（`class="a X"`），两个 class 属性是非法 XML
      const merged =
        classAttr.value === '' || idVal === undefined
          ? (idVal ?? classAttr.value)
          : `${classAttr.value} ${idVal}`;
      edits = [
        { start: span.start, end: span.end, text: '' },
        { start: classAttr.valueStart, end: classAttr.valueEnd, text: merged },
      ];
    } else {
      // 没有 class：只改属性名，值原样保留
      edits = [{ start: id.nameStart, end: id.nameEnd, text: 'class' }];
    }
    out.push({
      ...mkWarning(
        'vxml.rootPanelId',
        id.nameStart,
        id.nameEnd,
        msg.vxml.rootPanelId(panel.tag),
        msg.vxml.rootPanelIdFix(),
      ),
      edits,
    });
  }
}

// ---------------------------------------------------------------------------
// vxml.rootOnlyNested（warning）
// ---------------------------------------------------------------------------

function checkRootOnlyNested(
  doc: VxmlDocument,
  shape: RootShape,
  panels: PanelRegistry,
  msg: Messages,
  out: Diagnostic[],
): void {
  // 没有 <root> 就整条跳过：根面板是谁根本无从判断，此时把文档里每个 rootOnly
  // 类型都报成「嵌套」是拿一个未知当已知。缺 <root> 这个真正的错误已由
  // vxml.structure 独家报出——同一根因不挂两条。
  if (!shape.root) return;

  // 放行的是**根位置**（所有顶层 <root> 的直接子元素），不是「第一个 <root> 的」
  // ——见 RootShape.rootPositions 上的注释（T8 评审 Minor 5）。
  for (const el of walkElements(doc.roots)) {
    if (shape.rootPositions.has(el)) continue;
    // 通则（Ruling 25）：标签名的身份还没定就不判。敲 `<ContextMen` 的中途
    // 就是这个状态，此刻断言「它只能作根面板」与 `vxml.syntax` 的「开始标签
    // 缺 >」落在同一个 token 上。这一处是本轮按通则横扫时才发现的——最终评审
    // 那 2806 个变异用例没触发到它（rootOnly 类型在语料里全在根位置上）。
    if (!tagNameSettled(el)) continue;
    // 判据是 panels.json 的 rootOnly 位。标签不在 panels.json 里时 get() 返回
    // undefined，整个元素跳过——与 Ruling 17 同一条：对这个标签一无所知，就没有
    // 依据断言它「只能作根面板」。
    if (panels.get(el.tag)?.rootOnly !== true) continue;
    out.push(
      mkWarning(
        'vxml.rootOnlyNested',
        el.tagNameStart,
        el.tagNameEnd,
        msg.vxml.rootOnlyNested(el.tag),
        msg.vxml.rootOnlyNestedFix(),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// vxml.syntax（warning）—— 未闭合标签、属性值缺引号
// ---------------------------------------------------------------------------

/**
 * 属性值的引号毛病是**哪一种**；没毛病返回 undefined。
 *
 * 返回种类而不是现成文案，是为了让 attributeSyntaxBroken / judgeableAttributes
 * 这两个纯结构谓词不必拿到 Messages——后者还是导出的，被 custom-hud.ts 共用。
 * 文案在发射点由 quoteProblemMessage 按种类映射。
 */
type AttrQuoteKind = 'missing-close-quote' | 'unquoted';

function attrQuoteProblem(text: string, attr: VxmlAttribute): AttrQuoteKind | undefined {
  if (attr.unterminated) return 'missing-close-quote';
  if (attr.value !== undefined) return undefined;
  // 解析器对 `name=裸值` 的处理是：`name` 记成一个没有 value 的属性，扫描位置
  // 停在裸值的首字符上，裸值本身随后被当作下一个属性名读掉。所以「写了 = 却
  // 没有 value」这个组合，正是缺引号的判据。只写到 `name=` 的编辑中途状态也
  // 落在这里——它同样是「值还没合法地写出来」，报出来不算误报。
  let k = attr.nameEnd;
  while (k < text.length && /\s/.test(text[k])) k++;
  if (text[k] !== '=') return undefined;
  return 'unquoted';
}

/** 把种类映射成文案。唯一需要 Messages 的一半，只在发射点用到。 */
function quoteProblemMessage(
  kind: AttrQuoteKind,
  attrName: string,
  msg: Messages,
): { readonly message: string; readonly fix: string } {
  return kind === 'missing-close-quote'
    ? {
        message: msg.vxml.attrMissingCloseQuote(attrName),
        fix: msg.vxml.attrMissingCloseQuoteFix(attrName),
      }
    : { message: msg.vxml.attrUnquoted(attrName), fix: msg.vxml.attrUnquotedFix(attrName) };
}

/**
 * **通则（Ruling 24 / 25）的判据源**：这个属性的语法本身是不是坏的（缺引号 /
 * 缺右引号 / 只写到 `name=`）。
 *
 * 与 `vxml.syntax` 用的是**同一个函数**，不是抄一份等价条件——通则的原话是
 * 「那些位置由 `vxml.syntax` 独家负责」，两侧的判据一旦分叉，要么出现「语义规则
 * 让了位而 `vxml.syntax` 没接住」的静默漏报，要么出现「两边都报」的重复。这里
 * 只是把 `attrQuoteProblem` 的返回值折成布尔值，分叉在结构上不可能发生。
 *
 * **不导出**：唯一的消费方是 `judgeableAttributes()`。此前它被导出给
 * `custom-hud.ts` 单独调用，于是「未闭合的末尾属性」与「语法坏掉的属性」两条
 * 判据分居两处，各条规则接哪一条全凭当时的人记得——最终评审找到的三处漏网都
 * 是这么来的。现在两条合成一个入口，规则侧没有「只接一半」这个选项。
 */
function attributeSyntaxBroken(text: string, attr: VxmlAttribute): boolean {
  return attrQuoteProblem(text, attr) !== undefined;
}

/**
 * 元素是否由自己的闭合标签收尾。
 *
 * 解析器不单独记「有没有 `</tag>`」这个事实：正常闭合时 `closeTo` 把 `end` 设
 * 成闭合标签 `>` 之后的位置，没闭合时统一延伸到文档末尾，两者在 AST 上无法区分
 * （文件恰好以 `</tag>` 结尾时 `end` 也等于 `text.length`）。所以这里回到原文
 * 判：`end` 之前必须正好是 `</tag>`（`>` 前允许空白，与 `closeTo` 读标签名的
 * 口径一致）。
 *
 * 被祖先的闭合标签顺带收掉的元素（`<a><b></a>` 里的 `b`）拿到的是 `</a>` 结尾，
 * 判为未闭合——正是想要的结果。已知的一处漏判：同名嵌套且只闭合了一层
 * （`<Panel><Panel></Panel>`）时，外层拿到的尾巴恰好也是 `</Panel>`，会被当成
 * 已闭合。语料 540 个布局上这条判据零命中（见 corpus.test.ts 的 EXPECTED）。
 *
 * 不改解析器加一个字段，是因为 `parseVxml` 是 hover / 补全 / 符号 / 导航 /
 * 索引五条链路共享的组件，为一条诊断改它的 AST 形状不划算。
 */
function closedByEndTag(text: string, el: VxmlElement): boolean {
  let k = el.end - 1;
  if (text[k] !== '>') return false;
  k--;
  while (k >= 0 && /\s/.test(text[k])) k--;
  const nameEnd = k + 1;
  const nameStart = nameEnd - el.tag.length;
  if (nameStart < 2) return false;
  return (
    text.slice(nameStart, nameEnd) === el.tag &&
    text[nameStart - 1] === '/' &&
    text[nameStart - 2] === '<'
  );
}

/**
 * 元素**没有正常收尾**：开始标签缺 `>`，或者缺自己的闭合标签。
 * 两种形态在编辑中途都会让它一路延伸到文档末尾，把每一层祖先都拖成「未闭合」。
 */
function unterminated(text: string, el: VxmlElement): boolean {
  return el.unclosed || (!el.selfClosing && !closedByEndTag(text, el));
}

function checkSyntax(doc: VxmlDocument, msg: Messages, out: Diagnostic[]): void {
  const text = doc.text;
  for (const el of walkElements(doc.roots)) {
    // **每个元素只出一条**（属性各自一条），按「越具体越优先」取：
    //
    //   属性的引号毛病  >  开始标签缺 `>`  >  缺闭合标签
    //
    // 三者在编辑中途几乎总是同时成立——`<Panel class=` 一处笔误就把三条全占了。
    // 报三条说的是同一件事，且最靠前的那条才是用户真正要改的地方（补上引号，
    // 另外两条自己就消失了）。这与规格 §10.3 末段「范围重叠时保留更具体的那条」
    // 是同一条取舍。
    const quoteProblems = el.attributes
          .map((a) => ({ attr: a, kind: attrQuoteProblem(text, a) }))
          .filter((x) => x.kind !== undefined);
        if (quoteProblems.length > 0) {
          for (const { attr, kind } of quoteProblems) {
            const { message, fix } = quoteProblemMessage(kind!, attr.name, msg);
            out.push(mkWarning('vxml.syntax', attr.nameStart, attr.nameEnd, message, fix));
          }
      continue;
    }
    if (el.unclosed) {
      out.push(
        mkWarning(
          'vxml.syntax',
          el.tagNameStart,
          el.tagNameEnd,
          msg.vxml.missingGt(el.tag),
          msg.vxml.missingGtFix(el.tag),
        ),
      );
      continue;
    }
    if (!el.selfClosing && !closedByEndTag(text, el)) {
      // **一串未闭合的祖先只报最内层那一条**（T8 评审 Minor 4）。交付时一个漏掉的
      // 闭合标签会按未闭合祖先数放大：自上而下新写一个文件、还没写任何闭合标签时，
      // 嵌套深度 N 就刷 N 条 warning。Ruling 21 批准的是「就元素确实没闭合这件事
      // 报告」，不是按深度放大同一件事——那与 Ruling 19 / 21 关心的「用户正在敲的
      // 时候别刷屏」是同一类噪音。
      //
      // 判据只看**直接子元素**：子元素也没收尾，说明它俩同属一条未闭合链，这一层
      // 让位给更内层的那条。子元素都正常收了尾（`<root><Panel></Panel>` 缺 </root>）
      // 就照旧报——那是一处独立的遗漏。取最内层而不是最外层，是因为那里才是光标
      // 所在，而且补上一个闭合标签之后下一条会自动浮出来，逐层收敛。
      if (el.children.some((c) => unterminated(text, c))) continue;
      // 机械化修复：在元素内容末尾（最后一个子元素之后；无子元素则在开始标签
      // 之后）插入换行 + 与开始标签同缩进的 </tag>。这条只报最内层，应用后
      // 下一层会自己浮出来——修复循环逐层收敛，与诊断的逐层浮现是对称的。
      const insertAt = el.children.length > 0 ? el.children[el.children.length - 1].end : el.openEnd;
      const lineStart = text.lastIndexOf('\n', el.tagStart) + 1;
      const indent = /^[ \t]*/.exec(text.slice(lineStart, el.tagStart))![0];
      out.push({
        ...mkWarning(
          'vxml.syntax',
          el.tagNameStart,
          el.tagNameEnd,
          msg.vxml.missingCloseTag(el.tag),
          msg.vxml.missingCloseTagFix(el.tag),
        ),
        edits: [{ start: insertAt, end: insertAt, text: `\n${indent}</${el.tag}>` }],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// vxml.duplicateId（hint，配置键 panorama.diagnostics.duplicateId）
// ---------------------------------------------------------------------------
//
// **作用域模型（Ruling 20）**：`<snippet>` 是模板、各自独立实例化，因此**每个
// `<snippet>` 元素是一个独立的 id 作用域**，其余算「主树」作用域。同名 id 分处
// 两个不同 snippet 不算重复，同一个 snippet 内才算。
//
// 这不是理论洁癖，是语料实测逼出来的：同文件字面重复的朴素口径两构建合计 512
// 处，其中「两次都在 <snippets> 内」与「一次在内一次在外」占了一大半；按作用域
// 拆开并跳过空 `id=""`（80 处）之后剩 **244** 处，才是真的重复。
//
// 级别是 hint（规格 §10.2），配置键是它自己的 `panorama.diagnostics.duplicateId`
// （Ruling 4 / D-M4-5）——不并进 `unknownClass`：那个键按规格只管「class 引用
// 找不到定义」，塞进来会让用户关掉一个连带关掉另一个。

/**
 * 最近的祖先 `<snippet>`；没有则 null，表示主树作用域。
 *
 * **只看祖先、不含自身**：`<snippet>` 自己的 `id` 归**主树**作用域，而不是它自己
 * 开出来的那个作用域。理由是 id 的可见性看它挂在谁身上——`<snippet>` 元素本身是
 * 主树的一部分，被实例化出去的是它的**内容**。语料上不可达（带 `id` 的
 * `<snippet>` 0 个，两构建都是），正因为不可达才更需要钉住：这条取舍在 T8 交付时
 * 零测试覆盖，把 `el.parent` 起步改成 `el` 起步后 635 条 + 语料闸门一条都不红
 * （T8 评审 M-3）。现在 vxml-structure.test.ts 里两个方向各钉了一次。
 */
function snippetScopeOf(el: VxmlElement): VxmlElement | null {
  for (let p = el.parent; p; p = p.parent) if (p.tag === 'snippet') return p;
  return null;
}

function checkDuplicateId(doc: VxmlDocument, msg: Messages, out: Diagnostic[]): void {
  const scopes = new Map<VxmlElement | null, Set<string>>();
  for (const el of walkElements(doc.roots)) {
    // 通则（Ruling 25）：身份未定的属性不判。这条把区间挂在**取值里**，所以
    // 一个缺右引号的 `id="a` 会拿一段被截到行尾的垃圾文本去比对同名——
    // `<Label id="a" /><Label id="a` 实测双报（`vxml.syntax` + 本条）。
    const id = judgeableAttributes(doc.text, el).find((a) => a.name === 'id');
    if (!id || id.value === undefined || id.valueStart === undefined || id.valueEnd === undefined) {
      continue;
    }
    // 空 id 不是 id——语料里 80 处 `id=""`，把它们两两算重复纯属噪音
    if (id.value === '') continue;

    const scope = snippetScopeOf(el);
    let seen = scopes.get(scope);
    if (!seen) {
      seen = new Set<string>();
      scopes.set(scope, seen);
    }
    if (!seen.has(id.value)) {
      seen.add(id.value);
      continue;
    }
    // 报的是**第二次及以后**的出现，不是第一次。两者的条数与 message 完全相同，
    // 只有位置不同——所以语料闸门必须逐条钉 file:line（Ruling 20），
    // UNVALIDATABLE 那张按 message/文件分布钉形状的表对这个变体是瞎的。
    out.push(
      mkHint(
        'vxml.duplicateId',
        id.valueStart,
        id.valueEnd,
        msg.vxml.duplicateId(id.value),
        msg.vxml.duplicateIdFix(),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 编排（单文件）：这五条与 unknownTag / unknownAttribute 一样都是单文件判据，
// 不需要工作区索引。
// ---------------------------------------------------------------------------

export function checkVxmlStructure(
  doc: VxmlDocument,
  panels: PanelRegistry,
  msg: Messages,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const shape = rootShapeOf(doc);
  checkStructure(doc, shape, msg, out);
  checkRootPanelId(doc.text, shape, msg, out);
  checkRootOnlyNested(doc, shape, panels, msg, out);
  checkSyntax(doc, msg, out);
  checkDuplicateId(doc, msg, out);
  return out;
}
