import { describe, it, expect, beforeEach } from 'vitest';
import {
  registered,
  resetRegistrations,
  createOpenDocument,
  Position,
  Range,
  WorkspaceEdit,
} from '../../../mocks/vscode';
import { activate } from '../../../../src/vscode/extension';

/**
 * 灯泡 provider 的行为级测试：真实注册的回调被调用后，
 * 「光标落在确定性诊断上」要给出带 WorkspaceEdit 的 quick fix，
 * 「光标落在判断型诊断上」（display: flex）一个都不给。
 */

function providerOf(language: string): { provideCodeActions(doc: unknown, range: unknown): unknown } {
  const hit = registered.find((r) => r.language === language && r.type === 'codeaction');
  expect(hit, `${language} 未注册 codeaction provider`).toBeDefined();
  return hit!.provider as never;
}

beforeEach(() => {
  resetRegistrations();
  activate({ subscriptions: [] } as never);
});

describe('灯泡 quick fix', () => {
  it('custom_game 布局：Button text 上有灯泡，编辑是「删属性 + 包子 Label」', () => {
    const text = '<root>\n  <Button text="Go" />\n</root>\n';
    const doc = createOpenDocument(text, '/w/addon/panorama/layout/custom_game/b.xml', 'panorama-vxml');
    const provider = providerOf('panorama-vxml');

    const actions = provider.provideCodeActions(
      doc,
      new Range(new Position(1, 10), new Position(1, 10)),
    ) as { title: string; edit: WorkspaceEdit }[];

    expect(actions.length).toBe(1);
    const edits = actions[0].edit.replaces;
    // 删属性 + 删斜杠 + 展开闭合（三段编辑，原子一组）
    expect(edits.length).toBe(3);
    expect(edits.map((e) => e.newText).sort()).toEqual(['', '', '><Label text="Go" /></Button>']);
  });

  it('样式表：visibility: hidden 上有灯泡，替换为 collapse', () => {
    const text = '.a {\n  visibility: hidden;\n}\n';
    const doc = createOpenDocument(text, '/w/addon/panorama/styles/x.css', 'panorama-vcss');
    const provider = providerOf('panorama-vcss');

    const actions = provider.provideCodeActions(
      doc,
      new Range(new Position(1, 15), new Position(1, 15)),
    ) as { edit: WorkspaceEdit }[];

    expect(actions.length).toBe(1);
    const e = actions[0].edit.replaces[0];
    expect(e.newText).toBe('collapse');
    // character 是行内列号，回读区间要按行取
    const line = text.split('\n')[e.range.start.line];
    expect(line.slice(e.range.start.character, e.range.end.character)).toBe('hidden');
  });

  it('判断型诊断（display: flex）不给灯泡——没有唯一答案就不替用户猜', () => {
    const text = '.a {\n  display: flex;\n}\n';
    const doc = createOpenDocument(text, '/w/addon/panorama/styles/y.css', 'panorama-vcss');
    const provider = providerOf('panorama-vcss');

    const actions = provider.provideCodeActions(
      doc,
      new Range(new Position(1, 5), new Position(1, 5)),
    ) as unknown[];
    expect(actions).toEqual([]);
  });

  it('光标不在诊断上：不给任何操作', () => {
    const text = '<root>\n  <Button text="Go" />\n</root>\n';
    const doc = createOpenDocument(text, '/w/addon/panorama/layout/custom_game/b.xml', 'panorama-vxml');
    const provider = providerOf('panorama-vxml');
    const actions = provider.provideCodeActions(
      doc,
      new Range(new Position(2, 2), new Position(2, 2)),
    ) as unknown[];
    expect(actions).toEqual([]);
  });
});
