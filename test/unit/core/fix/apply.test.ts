import { describe, it, expect } from 'vitest';
import { applyFixEdits } from '../../../../src/core/fix/apply';
import type { Diagnostic, FixEdit } from '../../../../src/core/diagnostics/types';
import { parseVcss } from '../../../../src/core/vcss/parser';
import { parseVxml } from '../../../../src/core/vxml/parser';
import { diagnoseVcss, diagnoseVxml } from '../../../../src/core/diagnostics';
import { PropertyRegistry } from '../../../../src/core/data/properties';
import { PanelRegistry } from '../../../../src/core/data/panels';
import { ObservedAttributes } from '../../../../src/core/data/observed-attributes';
import { messagesFor } from '../../../../src/core/i18n';

/**
 * 修复闭环的单元化：诊断 → applyFixEdits → 复诊，一轮内全部确定性修复
 * 消失。这正是 MCP apply_fixes 与编辑器灯泡共享的同一条 core 路径——
 * 这里钉住文本级正确性，适配层只测接线。
 */

function diag(ruleId: string, edits: FixEdit[]): Diagnostic {
  return {
    ruleId: ruleId as Diagnostic['ruleId'],
    severity: 'warning',
    start: edits[0].start,
    end: edits[0].end,
    message: 'x',
    edits,
  };
}

describe('applyFixEdits 语义', () => {
  it('相邻区间（前一条的 end == 后一条的 start）都应用', () => {
    const r = applyFixEdits('ABCDEF', [diag('a', [{ start: 0, end: 3, text: 'x' }]), diag('b', [{ start: 3, end: 6, text: 'y' }])]);
    expect(r.text).toBe('xy');
    expect(r.applied).toHaveLength(2);
  });

  it('与已接受区间重叠的整条让位（半条修复比没有更糟）', () => {
    const r = applyFixEdits('ABCDEF', [
      diag('a', [{ start: 1, end: 4, text: 'x' }]),
      diag('b', [{ start: 3, end: 5, text: 'y' }]), // 与 a 重叠
    ]);
    expect(r.text).toBe('AxEF');
    expect(r.applied.map((d) => d.ruleId)).toEqual(['a']);
    expect(r.skipped.map((d) => d.ruleId)).toEqual(['b']);
  });

  it('同一条诊断的多处 edit 原子应用', () => {
    const r = applyFixEdits('a b c', [diag('a', [
      { start: 0, end: 1, text: 'X' },
      { start: 4, end: 5, text: 'Z' },
    ])]);
    expect(r.text).toBe('X b Z');
  });

  it('没有 edits 的诊断不参与', () => {
    const r = applyFixEdits('ABC', [diag('a', [{ start: 0, end: 1, text: 'x' }])]);
    const none = applyFixEdits('ABC', [{ ...diag('a', [{ start: 0, end: 1, text: 'x' }]), edits: undefined }]);
    expect(none.applied).toHaveLength(0);
    expect(none.text).toBe('ABC');
    expect(r.text).toBe('xBC');
  });

  it('同一位置的纯插入互为冲突：整条让位，绝不原地拼接', () => {
    const r = applyFixEdits('ab', [
      diag('a', [{ start: 1, end: 1, text: 'X' }]),
      diag('b', [{ start: 1, end: 1, text: 'Y' }]),
    ]);
    expect(r.applied.map((d) => d.ruleId)).toEqual(['a']);
    expect(r.skipped.map((d) => d.ruleId)).toEqual(['b']);
    expect(r.text).toBe('aXb'); // 不是 aXYb / aYXb
  });
});

const props = PropertyRegistry.load('en');
const panels = PanelRegistry.load('en');
const observed = ObservedAttributes.load();
const msg = messagesFor('en');

describe('修复闭环 · VCSS', () => {
  const CSS = [
    '.a {',
    '  visibility: hidden;',
    '  box-shadow: 0px 2px 4px 0px #000000ff;',
    '  transition: width 0.5s ease-out;',
    '}',
    '@keyframes pulse { from { opacity: 1; } to { opacity: 0.2; } }',
  ].join('\n');

  it('四类确定性修复一轮清零', () => {
    const ds = diagnoseVcss(parseVcss(CSS), { uri: 'x.css', props, msg });
    const fixable = ds.filter((d) => d.edits);
    expect(fixable.map((d) => d.ruleId).sort()).toEqual([
      'vcss.boxShadowColorFirst',
      'vcss.keyframesUnquoted',
      'vcss.visibilityHidden',
      'vcss.webOnlyProperty', // transition 简写拆分挂在这条规则下
    ]);

    const r = applyFixEdits(CSS, ds);
    expect(r.applied).toHaveLength(4);
    expect(r.text).toBe(
      [
        '.a {',
        '  visibility: collapse;',
        '  box-shadow: #000000ff 0px 2px 4px 0px;',
        '  transition-property: width;',
        '  transition-duration: 0.5s;',
        '  transition-timing-function: ease-out;',
        '  transition-delay: 0s;',
        '}',
        '@keyframes "pulse" { from { opacity: 1; } to { opacity: 0.2; } }',
      ].join('\n'),
    );

    // 复诊：这四类全部消失
    const again = diagnoseVcss(parseVcss(r.text), { uri: 'x.css', props, msg });
    expect(again.filter((d) => ['vcss.visibilityHidden', 'vcss.keyframesUnquoted', 'vcss.boxShadowColorFirst', 'vcss.webOnlyProperty'].includes(d.ruleId))).toEqual([]);
  });

  it('transition 多段（逗号）不产出 edits——形态不唯一', () => {
    const ds = diagnoseVcss(parseVcss('.a { transition: width 1s, height 2s; }'), { uri: 'x.css', props, msg });
    const t = ds.find((d) => d.ruleId === 'vcss.webOnlyProperty');
    expect(t?.fix).toBeTruthy(); // 文字版仍在
    expect(t?.edits).toBeUndefined(); // 机械化版克制
  });
});

describe('修复闭环 · VXML（完整模式）', () => {
  const XML = ['<root>', '  <Panel id="X" class="a">', '    <Label text="hi" />', '</root>'].join('\n');

  it('根面板 id 按提示转 class（已有时并入）+ 补闭合标签，缩进与原文对齐', () => {
    const ds = diagnoseVxml(parseVxml(XML), { uri: 'x.xml', mode: 'full', panels, observed, msg });
    const r = applyFixEdits(XML, ds);
    expect(r.applied.map((d) => d.ruleId).sort()).toEqual(['vxml.rootPanelId', 'vxml.syntax']);
    // fix 文案说「用 class 挂样式」：id 的名字保留并入既有 class，而不是删除
    expect(r.text).toBe(['<root>', '  <Panel class="a X">', '    <Label text="hi" />', '  </Panel>', '</root>'].join('\n'));

    const again = diagnoseVxml(parseVxml(r.text), { uri: 'x.xml', mode: 'full', panels, observed, msg });
    expect(again.filter((d) => d.ruleId === 'vxml.rootPanelId' || d.ruleId === 'vxml.syntax')).toEqual([]);
  });
});

describe('修复闭环 · CustomHudLayout', () => {
  const XML = ['<root>', '  <Button text="Go" />', '  <Label text="{d:score}" />', '</root>'].join('\n');

  it('buttonText 双编辑展开自闭合 + binding 前缀置换', () => {
    const ds = diagnoseVxml(parseVxml(XML), { uri: 'c.xml', mode: 'customHudLayout', panels, observed, msg });
    const r = applyFixEdits(XML, ds);
    expect(r.applied.map((d) => d.ruleId).sort()).toEqual(['hud.binding', 'hud.buttonText']);
    expect(r.text).toBe(
      ['<root>', '  <Button><Label text="Go" /></Button>', '  <Label text="{s:score}" />', '</root>'].join('\n'),
    );

    const again = diagnoseVxml(parseVxml(r.text), { uri: 'c.xml', mode: 'customHudLayout', panels, observed, msg });
    expect(again.filter((d) => String(d.ruleId).startsWith('hud.'))).toEqual([]);
  });

  it('已配对的 Button：text 挪为首个子元素', () => {
    const xml = '<root><Button text="Go"><Panel /></Button></root>';
    const ds = diagnoseVxml(parseVxml(xml), { uri: 'c.xml', mode: 'customHudLayout', panels, observed, msg });
    const r = applyFixEdits(xml, ds);
    expect(r.text).toBe('<root><Button><Label text="Go" /><Panel /></Button></root>');
  });

  it('未闭合的 Button：两处插入同落 openEnd，一轮一个、两轮收敛（评审 #4）', () => {
    const xml = '<root><Button text="Go"></root>';
    const diagnose = (t: string) =>
      diagnoseVxml(parseVxml(t), { uri: 'c.xml', mode: 'customHudLayout', panels, observed, msg });

    const r1 = applyFixEdits(xml, diagnose(xml));
    // buttonText 的首个 edit（删属性）更靠前，它赢；补 </Button> 的插入整条让位
    expect(r1.applied.map((d) => d.ruleId)).toEqual(['hud.buttonText']);
    expect(r1.skipped.map((d) => d.ruleId)).toEqual(['vxml.syntax']);
    expect(r1.text).toBe('<root><Button><Label text="Go" /></root>');

    const r2 = applyFixEdits(r1.text, diagnose(r1.text));
    expect(r2.applied.map((d) => d.ruleId)).toEqual(['vxml.syntax']);
    // 补闭合标签的插入带换行 + 开始标签行缩进；Button 在文档首行，缩进为空
    expect(r2.text).toBe('<root><Button><Label text="Go" />\n</Button></root>');

    // 第三轮：没有可证问题，闭环终止
    expect(diagnose(r2.text).filter((d) => d.edits)).toEqual([]);
  });
});
