import { describe, it, expect, beforeEach } from 'vitest';
import { registered, resetRegistrations } from '../../mocks/vscode';
import { activate } from '../../../src/vscode/extension';

describe('activate', () => {
  beforeEach(() => {
    resetRegistrations();
    activate({ subscriptions: [] } as never);
  });

  it('为两种语言各注册补全、悬停、文档符号、跳转定义、查找引用与灯泡', () => {
    for (const language of ['panorama-vxml', 'panorama-vcss']) {
      for (const type of ['completion', 'hover', 'symbol', 'definition', 'reference', 'codeaction']) {
        expect(
          registered.some((r) => r.language === language && r.type === type),
          `${language} 缺少 ${type} provider`,
        ).toBe(true);
      }
    }
  });

  it('VCSS 额外注册颜色 provider', () => {
    expect(registered.some((r) => r.language === 'panorama-vcss' && r.type === 'color')).toBe(
      true,
    );
    // 反向断言：VXML 没有颜色字面量语法，不应该也注册一个——否则上面那条
    // 正向断言在「两种语言都注册了」的坏实现下也会蒙混过关。
    expect(registered.some((r) => r.language === 'panorama-vxml' && r.type === 'color')).toBe(
      false,
    );
  });

  it('注册的 provider 全部进入 subscriptions 以便卸载', () => {
    const ctx = { subscriptions: [] as unknown[] };
    resetRegistrations();
    activate(ctx as never);
    // 不能再断言相等：M3 起 createIndexHost 也会把文件监视器与文档变更监听器
    // 放进 subscriptions，这些不出现在 registered 里（那张表只记 languages.register*）。
    // 这里真正要守住的不变式是「provider 一个都没漏」，用 >= 而不是 ===。
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(registered.length);
    // 但光数量够不代表没漏——数量测不出「漏了一个 provider、宿主又刚好多塞了
    // 一个订阅」这种巧合（比如加了第 7 个 provider 却忘了 push，索引宿主固定
    // 多加 3 个订阅，计数照样够）。按身份逐个核对：每个注册项返回的 disposable
    // 必须真的在 subscriptions 里，否则 deactivate 时它不会被释放。
    for (const r of registered) {
      expect(ctx.subscriptions).toContain(r.disposable);
    }
  });
});

// ---- 以下为 M4 Task 10（诊断宿主接线）所需，追加，勿改动上方已有内容 ----
//
// import 放在这里而不是并进文件顶部那条：本文件按里程碑「只追加」，改动既有行
// 会让后续评审分不清哪些断言是本轮新写的。ESM 允许模块顶层的 import 出现在
// 任何位置，语义与写在最前面完全相同。
import { __diagnosticCollections } from '../../mocks/vscode';

describe('activate · 诊断宿主', () => {
  it('激活时建立诊断集合，并把它放进 subscriptions 以便卸载', () => {
    __diagnosticCollections.length = 0;
    const ctx = { subscriptions: [] as unknown[] };
    activate(ctx as never);

    // 一个集合，不是每个 provider 各建一个——多建的那些没人会清，卸载后
    // 波浪线会留在编辑器里。
    expect(__diagnosticCollections).toHaveLength(1);
    expect(__diagnosticCollections[0].name).toBe('panorama');
    expect(ctx.subscriptions).toContain(__diagnosticCollections[0]);
  });

  /*
   * 触发字符决定「敲到什么会自动弹补全」。VSCode 的 editor.quickSuggestions
   * 默认是 strings: off——属性值在语法上是字符串记号，所以在 class= 的引号里
   * 敲字母不会自动触发。若引号本身也不在触发字符里，跨文件类名补全在真实编辑
   * 器里就只能靠用户自己按 Ctrl+Space，等同于看不见。
   *
   * 这条与 package.json 的 configurationDefaults 是一对：触发字符负责「弹出来」，
   * configurationDefaults 负责「继续敲字母时还跟着筛」。少一个都不完整。
   */
  it('VXML 补全把引号与斜杠列为触发字符——属性值里的候选要能自动弹出来', () => {
    const c = registered.find(
      (r) => r.language === 'panorama-vxml' && r.type === 'completion',
    );
    expect(c, 'VXML 补全未注册').toBeDefined();
    expect(c!.triggerCharacters, '属性值里的候选靠引号触发').toContain('"');
    expect(c!.triggerCharacters, '逐段路径补全靠斜杠触发').toContain('/');
  });

  it('VCSS 补全的触发字符覆盖选择器与 at-rule', () => {
    const c = registered.find(
      (r) => r.language === 'panorama-vcss' && r.type === 'completion',
    );
    for (const ch of ['.', '#', ':', '@']) {
      expect(c!.triggerCharacters, `VCSS 缺少触发字符 ${ch}`).toContain(ch);
    }
  });
});
