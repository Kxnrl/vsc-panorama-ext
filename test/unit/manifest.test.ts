import { describe, it, expect } from 'vitest';
import manifest from '../../package.json';
import nlsEn from '../../package.nls.json';
import nlsZh from '../../package.nls.zh-cn.json';
import {
  ALLOWED_LEVELS,
  ALL_RULE_IDS,
  DEFAULT_DIAGNOSTIC_SETTINGS,
  RULE_GROUP,
  SETTING_KEYS,
} from '../../src/core/diagnostics/types';
import type { SettingKey } from '../../src/core/diagnostics/types';

describe('扩展清单（规格 §13 跨编辑器兼容硬约束）', () => {
  it('engines.vscode 下限是 MCP 稳定 API 的最低版 ^1.101.0', () => {
    // 原为 ^1.85.0（各分支基线落后于上游，写高装不上）。引入嵌入式 MCP 后
    // 门槛由 vscode.lm.registerMcpServerDefinitionProvider 的稳定线决定：
    // 1.100 及以前它只在 proposed API 里（bisect @types/vscode 的 vscode.d.ts，
    // 1.101.0 起收录）。这是刻意拍板的取舍——老版本用户升不上新版，但换来
    // 原生 agent 通道零 proposed API 依赖。再要动这个数，先重跑那次 bisect。
    expect(manifest.engines?.vscode).toBe('^1.101.0');
  });

  it('不声明任何 proposed API', () => {
    // 任何 enabledApiProposals 都会让扩展在分支上直接拒载
    expect(manifest).not.toHaveProperty('enabledApiProposals');
  });

  it('入口指向 esbuild 打出的单文件', () => {
    expect(manifest.main).toBe('./dist/extension.js');
  });

  it('绝不声明 type: module（扩展主机加载 CJS）', () => {
    // 断言真实约束而非「不存在 type」——显式写 "type": "commonjs" 是无害的
    expect((manifest as { type?: string }).type).not.toBe('module');
  });
});

/**
 * 诊断开关（规格 §10.4）。这里守的是**清单与 core 层类型表之间的对应**——两边
 * 各写各的，任何一边加/删/拼错一个键，用户在设置界面看到的开关就和实际生效的
 * 配置组对不上，而 core 层的 694 条测试对此一无所知（它们只看 SettingKey，
 * 从不读 package.json）。
 *
 * 键是 **7 个**，比规格 §10.4 原文那张表多两个，两次都是同一个原因——那张表
 * 表达不了它自己 §10.1/§10.2 要求的级别：
 * - `unresolvedReference`（D-M4-4）：§10.1 要求 warning 级，塞进 `unknownClass`
 *   （hint）就降了级；
 * - `duplicateId`（Ruling 4 / D-M4-5）：§10.2 要求 hint 级，而计划的 RULE_GROUP
 *   把它放进了 `structure`（warning）。并进 `unknownClass` 级别虽对，名字却在
 *   说谎——那个键按规格只管「class= 找不到定义」。
 */
describe('诊断开关（规格 §10.4 + 新拆的两个键）', () => {
  const PREFIX = 'panorama.diagnostics.';
  const props = manifest.contributes.configuration.properties as Record<
    string,
    { type?: string; default?: unknown; enum?: readonly string[]; description?: string }
  >;
  const declared = Object.keys(props)
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length));

  /**
   * 每个键的取值域**取自 core 的 `ALLOWED_LEVELS`，这里不抄第二份**
   * （最终评审 M-6）。交付时这份表是逐键抄的字面量，于是这件事在仓库里有三份
   * 拷贝：`package.json` 的 `enum`、这里的 `ENUMS`、以及适配层
   * `readDiagnosticSettings` 里那张**全局** `LEVELS`。前两份对得上，第三份对不上
   * ——而恰恰是第三份决定运行时行为。抄成两份就意味着「谁跟谁对齐」全凭人记得。
   *
   * 改成引用之后，这个 describe 的职责变成**只有它能承担的那一件**：把
   * `package.json`（一份 tsc 管不到、运行时也不校验的 JSON）绑到 core 的真值上。
   */
  const ENUMS: Readonly<Record<SettingKey, readonly string[]>> = ALLOWED_LEVELS;

  it('清单里的诊断开关与 SettingKey 逐个对得上——多一个、少一个、拼错都要红', () => {
    expect([...declared].sort()).toEqual([...SETTING_KEYS].sort());
  });

  it('每个开关的默认值与 DEFAULT_DIAGNOSTIC_SETTINGS 逐字一致', () => {
    for (const key of SETTING_KEYS) {
      expect(props[PREFIX + key]?.default, `${PREFIX}${key} 的默认值与 core 层不一致`).toBe(
        DEFAULT_DIAGNOSTIC_SETTINGS[key],
      );
    }
  });

  it('每个开关都是字符串枚举，取值域与 §10.4 逐条一致且含自身默认值', () => {
    for (const key of SETTING_KEYS) {
      const p = props[PREFIX + key];
      expect(p?.type, `${PREFIX}${key} 应声明为 string`).toBe('string');
      expect(p?.enum, `${PREFIX}${key} 的取值域`).toEqual(ENUMS[key]);
      // 默认值必须落在自己的取值域内，否则设置界面会把默认值显示成非法值
      expect(ENUMS[key], `${PREFIX}${key} 的默认值不在取值域里`).toContain(
        DEFAULT_DIAGNOSTIC_SETTINGS[key],
      );
      // 换成 %key% 占位之后，这里直接断言 description 非空会永远为真——哪怕两份
            // nls 里根本没有这个 key。必须穿透解析，见下面那组「package.nls 本地化」。
            expect(resolveNls(p?.description ?? '', `${PREFIX}${key}`)).not.toBe('');
    }
  });

  it('每个开关都真的管着至少一条规则——清单侧的反向核对', () => {
    // types.test.ts 已经从 SETTING_KEYS 一侧查过「组不能是空的」。这里从**清单**
    // 一侧再查一次：清单里多出一个 core 层不认识的键时，上面那条会红；而清单里
    // 的键拼对了、RULE_GROUP 却没有任何规则指向它时，这条会红。
    for (const key of declared) {
      const owned = ALL_RULE_IDS.filter((id) => RULE_GROUP[id] === (key as SettingKey));
      expect(owned.length, `清单里的 ${PREFIX}${key} 没有任何规则归属它`).toBeGreaterThan(0);
    }
  });
});

/*
 * configurationDefaults 是「补全在真实编辑器里能不能自动弹」的另一半。
 * VSCode 的 editor.quickSuggestions 默认 strings: off，而属性值与取值在语法上
 * 都是字符串记号——不声明这个默认值，用户在 class= 的引号里敲字母就没有候选，
 * 跨文件类名补全等同于不存在。触发字符（见 activation.test.ts）负责「弹出来」，
 * 这条负责「继续敲字母时还跟着筛」，两者缺一不可。
 */
describe('contributes.configurationDefaults', () => {
  it('两种语言都放开字符串记号内的自动补全', () => {
    // package.json 是以 JSON module 导入的，TS 会推出「恰好只有这两个键」的字面量
    // 类型，动态索引取不到；这里的意图正是「按语言 id 动态查」，故显式放宽。
    const d = manifest.contributes.configurationDefaults as unknown as Record<
      string,
      Record<string, { strings?: boolean; other?: boolean }> | undefined
    >;
    expect(d, 'configurationDefaults 缺失：补全在字符串里不会自动弹').toBeDefined();
    for (const lang of ['panorama-vxml', 'panorama-vcss']) {
      const qs = d[`[${lang}]`]?.['editor.quickSuggestions'];
      expect(qs, `${lang} 没有声明 editor.quickSuggestions`).toBeDefined();
      expect(qs!.strings, `${lang} 的 strings 必须为 true`).toBe(true);
      expect(qs!.other, `${lang} 的 other 必须为 true`).toBe(true);
    }
  });
});

type Bundle = Readonly<Record<string, string>>;
const EN: Bundle = nlsEn;
const ZH: Bundle = nlsZh;
const PLACEHOLDER = /^%(.+)%$/;

/**
 * 把 `%key%` 占位穿透解析成英文兜底文案；不是占位就原样返回。
 *
 * 解析失败（占位但 nls 里没有该 key）时返回空串，让调用方的「非空」断言变红——
 * 这正是本地化改造前那条断言丢掉的证伪能力。
 */
function resolveNls(raw: string, where: string): string {
  const m = PLACEHOLDER.exec(raw.trim());
  if (!m) return raw.trim();
  const v = EN[m[1]];
  if (typeof v !== 'string') {
    throw new Error(`${where} 的占位 %${m[1]}% 在 package.nls.json 里没有对应文案`);
  }
  return v.trim();
}

describe('package.nls 本地化', () => {
  it('两份 nls 的 key 集合完全相等', () => {
    const a = Object.keys(EN).sort();
    const b = Object.keys(ZH).sort();
    expect(a.length, 'nls 是空的，本组会空转').toBeGreaterThanOrEqual(12);
    expect(a).toEqual(b);
  });

  /*
   * 每个 %key% 占位在两份 nls 里都解析得到非空文案。
   *
   * 这条与上面那条 resolveNls 断言互补：那条只查英文（兜底那一份），这条把
   * 中文也一并查了。漏掉中文的话，中文用户在设置界面看到的是原样的 %key%。
   */
  it('清单里的每个 %key% 占位在两份 nls 里都有非空文案', () => {
    const raws: Array<[string, string]> = [['description', manifest.description]];
    const props = (
      manifest as unknown as {
        contributes: { configuration: { properties: Record<string, { description?: string }> } };
      }
    ).contributes.configuration.properties;
    for (const [k, v] of Object.entries(props)) {
      if (typeof v.description === 'string') raws.push([k, v.description]);
    }
    const placeholders = raws.filter(([, raw]) => PLACEHOLDER.test(raw.trim()));
    expect(placeholders.length, '一个 %key% 占位都没有，本条会空转').toBeGreaterThanOrEqual(12);

    for (const [where, raw] of placeholders) {
      const key = PLACEHOLDER.exec(raw.trim())![1];
      for (const [name, bundle] of [
        ['package.nls.json', EN],
        ['package.nls.zh-cn.json', ZH],
      ] as const) {
        const v = bundle[key];
        expect(typeof v, `${name} 缺 key：${key}（来自 ${where}）`).toBe('string');
        expect(v.trim(), `${name} 的 ${key} 是空串`).not.toBe('');
      }
    }
  });

  /*
   * 清单里不能再残留任何中文字面量——那说明有一条漏了 nls 化，英文用户会
   * 在设置界面看到中文。
   */
  it('package.json 里没有残留的中文字面量', () => {
    const hits: string[] = [];
    const walk = (o: unknown, path: string): void => {
      if (typeof o === 'string') {
        if (/[一-龥]/.test(o)) hits.push(`${path} = ${o.slice(0, 40)}`);
      } else if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
      }
    };
    walk(manifest, '');
    expect(hits, `以下清单字段仍是中文，应改走 nls：\n${hits.join('\n')}`).toEqual([]);
  });

  /*
   * 英文兜底文件里不能有汉字。任何没有专门 nls 文件的显示语言（日语、德语…）
   * 都落到这一份，混进中文等于给他们发中文。
   */
  it('英文兜底文件零汉字，中文文件确实是中文', () => {
    for (const [k, v] of Object.entries(EN)) {
      expect(/[一-龥]/.test(v), `package.nls.json 的 ${k} 里有汉字：${v}`).toBe(false);
    }
    for (const [k, v] of Object.entries(ZH)) {
      expect(/[一-龥]/.test(v), `package.nls.zh-cn.json 的 ${k} 里没有汉字：${v}`).toBe(true);
    }
  });
});
