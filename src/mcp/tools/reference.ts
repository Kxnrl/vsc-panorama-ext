import type { PanelRegistry } from '../../core/data/panels';
import type { PropertyRegistry } from '../../core/data/properties';

export interface PanelInfoInput {
  /** 不给：列出全部面板类型 */
  readonly panel?: string;
}

export interface AttributeDetail {
  readonly name: string;
  /** 真正声明该属性的类型（继承链上的哪一层） */
  readonly declaredBy: string;
  /** 属性文档；数据缺条目时省略 */
  readonly doc?: string;
}

export interface PanelDetail {
  readonly ok: true;
  readonly panel: string;
  readonly derivedFrom: string | null;
  /** true = 只能作根面板（43 种） */
  readonly rootOnly: boolean;
  readonly attributeCount: number;
  readonly attributes: readonly AttributeDetail[];
}

export interface PanelList {
  readonly ok: true;
  readonly count: number;
  readonly panels: readonly { name: string; rootOnly: boolean }[];
}

export interface PanelUnknown {
  readonly ok: false;
  readonly panel: string;
  /** 「不在清单 ≠ 不存在」——见 noteDataIncomplete */
  readonly note: string;
}

export type PanelInfoResult = PanelDetail | PanelList | PanelUnknown;

export function panelInfo(
  input: PanelInfoInput,
  panels: PanelRegistry,
  noteDataIncomplete: () => string,
): PanelInfoResult {
  if (input.panel === undefined) {
    return {
      ok: true,
      count: panels.allPanels().length,
      panels: panels.allPanels().map((name) => ({ name, rootOnly: panels.get(name)!.rootOnly })),
    };
  }

  const info = panels.get(input.panel);
  if (!info) return { ok: false, panel: input.panel, note: noteDataIncomplete() };

  // 守卫之后捕获，让 map 回调里拿到的是 string 而不是 string | undefined
  const panel = input.panel;
  const attributes: AttributeDetail[] = panels.attributesOf(panel).map((attr) => {
    const declarer = panels.declarerOf(panel, attr) ?? panel;
    const doc = panels.docFor(attr);
    return { name: attr, declaredBy: declarer, ...(doc ? { doc } : {}) };
  });

  return {
    ok: true,
    panel,
    derivedFrom: info.derivedFrom,
    rootOnly: info.rootOnly,
    attributeCount: attributes.length,
    attributes,
  };
}

export interface PropertyInfoInput {
  /** 不给：列出全部已知条目 */
  readonly name?: string;
}

export type PropertyLookup =
  | {
      readonly kind: 'property';
      readonly name: string;
      readonly panoramaOnly: boolean;
      /** 990 文件语料里的出现次数——agent 判断「常用程度」的直接信号 */
      readonly frequency: number;
      readonly description: string;
      readonly values: readonly string[];
      readonly webEquivalent?: string;
    }
  | {
      readonly kind: 'function';
      readonly name: string;
      readonly signature: string;
      readonly description: string;
    }
  | {
      readonly kind: 'at-rule';
      readonly name: string;
      readonly signature: string;
      readonly description: string;
    }
  | {
      /** Web 独有：Panorama 没有它，hint 是替代写法 */
      readonly kind: 'web-only';
      readonly name: string;
      readonly replacement: string;
    };

export interface PropertyDetail {
  readonly ok: true;
  readonly lookup: PropertyLookup | undefined;
  /** lookup 为 undefined（不在已知清单）时附上，防 agent 把「没见过」当「不存在」 */
  readonly note?: string;
}

export interface PropertyList {
  readonly ok: true;
  readonly properties: readonly string[];
  readonly functions: readonly string[];
  readonly atRules: readonly string[];
  readonly pseudoClasses: readonly string[];
}

export type PropertyInfoResult = PropertyDetail | PropertyList;

/**
 * 一个名字按 属性 → 函数 → at-rule → Web 独有 的顺序查。
 * 每种至多命中一个（函数名和属性名在数据里不相交），全不中时 lookup 为
 * undefined 并附「数据不全」说明——LLM 写 web CSS 是这个工具存在的理由，
 * 「unknown 就说 unknown」会反过来强化幻觉。
 */
export function propertyInfo(
  input: PropertyInfoInput,
  props: PropertyRegistry,
  noteDataIncomplete: () => string,
): PropertyInfoResult {
  if (input.name === undefined) {
    return {
      ok: true,
      properties: props.allProperties(),
      functions: props.functions().map((f) => f.name),
      atRules: props.allAtRules(),
      pseudoClasses: props.pseudoClasses(),
    };
  }

  const name = input.name;

  const prop = props.get(name);
  if (prop) {
    return {
      ok: true,
      lookup: {
        kind: 'property',
        name,
        panoramaOnly: prop.panoramaOnly,
        frequency: prop.frequency,
        description: prop.description,
        values: prop.values,
        ...(prop.webEquivalent ? { webEquivalent: prop.webEquivalent } : {}),
      },
    };
  }

  const fn = props.functions().find((f) => f.name === name);
  if (fn) {
    return { ok: true, lookup: { kind: 'function', name, signature: fn.signature, description: fn.description } };
  }

  const at = props.atRule(name);
  if (at) {
    return { ok: true, lookup: { kind: 'at-rule', name, signature: at.signature, description: at.description } };
  }

  const webOnly = props.webOnlyHint(name);
  if (webOnly !== undefined) {
    return { ok: true, lookup: { kind: 'web-only', name, replacement: webOnly } };
  }

  return { ok: true, lookup: undefined, note: noteDataIncomplete() };
}
