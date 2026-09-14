import type { Locale } from '../i18n/locale';
import rawPropertyData from '../../../data/vcss-properties.json';

/**
 * 数据文件里一条文案的双语形态。注册表构造时解析成普通 string，
 * 因此 core 内部所有读取点（info.description 等）看到的永远是字符串。
 */
export interface LocalizedString {
  readonly 'zh-cn': string;
  readonly en: string;
}

/*
 * 类型一分为二是刻意的：
 *
 * - Raw* 是 JSON 的真实形状，文案字段是 LocalizedString；
 * - PropertyInfo / PropertyData 是注册表持有的形状，文案已解析成 string。
 *
 * 好处有两个：core 内部所有读取点一行都不用改；而 from(data) 仍然收「已解析」
 * 的数据，既有测试的 fixture 不受影响，不必为了本地化把每个 fixture 都改成双语。
 */
export interface RawPropertyInfo {
  readonly panoramaOnly: boolean;
  readonly frequency: number;
  readonly description: LocalizedString;
  readonly values: readonly string[];
  readonly webEquivalent?: LocalizedString;
}

export interface RawFunctionInfo {
  readonly name: string;
  readonly signature: LocalizedString;
  readonly description: LocalizedString;
}

export interface RawAtRuleInfo {
  readonly signature: LocalizedString;
  readonly description: LocalizedString;
}

export interface RawPropertyData {
  readonly properties: Readonly<Record<string, RawPropertyInfo>>;
  readonly functions: readonly RawFunctionInfo[];
  readonly atRules: Readonly<Record<string, RawAtRuleInfo>>;
  readonly pseudoClasses: readonly string[];
  readonly webOnly: Readonly<Record<string, LocalizedString>>;
}

export interface PropertyInfo {
  readonly panoramaOnly: boolean;
  readonly frequency: number;
  readonly description: string;
  readonly values: readonly string[];
  readonly webEquivalent?: string;
}

export interface FunctionInfo {
  readonly name: string;
  readonly signature: string;
  readonly description: string;
}

export interface AtRuleInfo {
  readonly signature: string;
  readonly description: string;
}

export interface PropertyData {
  readonly properties: Readonly<Record<string, PropertyInfo>>;
  readonly functions: readonly FunctionInfo[];
  readonly atRules: Readonly<Record<string, AtRuleInfo>>;
  readonly pseudoClasses: readonly string[];
  /** Web 独有、Panorama 不存在的属性 -> 替代写法提示 */
  readonly webOnly: Readonly<Record<string, string>>;
}

const EMPTY: readonly string[] = Object.freeze([]);

/**
 * 一次性把双语数据折叠成单语。
 *
 * 三个 Record 都用 Object.create(null) 建：JSON 经 import 进来是普通对象字面量，
 * 带 Object.prototype，`webOnly['toString']` 会拿到一个函数。下面 webOnlyHint 已经
 * 加了 hasOwn 守卫，这里再把原型摘掉，两道互不依赖。
 */
function resolve(raw: RawPropertyData, locale: Locale): PropertyData {
  const properties: Record<string, PropertyInfo> = Object.create(null);
  for (const [name, info] of Object.entries(raw.properties)) {
    properties[name] = {
      panoramaOnly: info.panoramaOnly,
      frequency: info.frequency,
      description: info.description[locale],
      values: info.values,
      ...(info.webEquivalent ? { webEquivalent: info.webEquivalent[locale] } : {}),
    };
  }

  const atRules: Record<string, AtRuleInfo> = Object.create(null);
  for (const [name, info] of Object.entries(raw.atRules)) {
    atRules[name] = {
      signature: info.signature[locale],
      description: info.description[locale],
    };
  }

  const webOnly: Record<string, string> = Object.create(null);
  for (const [name, v] of Object.entries(raw.webOnly)) webOnly[name] = v[locale];

  return {
    properties,
    functions: raw.functions.map((f) => ({
      name: f.name,
      signature: f.signature[locale],
      description: f.description[locale],
    })),
    atRules,
    pseudoClasses: raw.pseudoClasses,
    webOnly,
  };
}

export class PropertyRegistry {
  private readonly data: PropertyData;

  private constructor(data: PropertyData) {
    this.data = data;
  }

  /**
   * locale 不给默认值是刻意的：漏传即编译错误。
   *
   * 给了默认值的话，某个调用点忘了接线的后果就变成「英文用户静默收到中文」——
   * 诊断照常出现、条数照常正确、所有测试全绿，只有真实用户看得见。与
   * VxmlDiagCtx 把 panels / observed 定为必填是同一条推理。
   */
  static load(locale: Locale): PropertyRegistry {
    return new PropertyRegistry(resolve(rawPropertyData as unknown as RawPropertyData, locale));
  }

  /** 供测试注入自定义数据。收的是**已解析**的单语数据，因此签名不带 locale。 */
  static from(data: PropertyData): PropertyRegistry {
    return new PropertyRegistry(data);
  }

  has(prop: string): boolean {
    return Object.hasOwn(this.data.properties, prop);
  }

  /**
   * 直接用 [] 索引一个不存在的 key 会顺着原型链拿到 Object.prototype 上的
   * 同名成员（如 'constructor' / '__proto__' / 'toString'）—— 那些是函数或
   * 内建对象，不是 PropertyInfo，一旦被当成数据用（如对 .values 取 .join）
   * 就会抛异常。get / valuesOf 统一经这里过一遍 has()，保证不存在的属性名
   * 永远只得到 undefined。
   */
  get(prop: string): PropertyInfo | undefined {
    return this.has(prop) ? this.data.properties[prop] : undefined;
  }

  valuesOf(prop: string): readonly string[] {
    return this.get(prop)?.values ?? EMPTY;
  }

  isPanoramaOnly(prop: string): boolean {
    return this.data.properties[prop]?.panoramaOnly ?? false;
  }

  /**
   * 返回替代写法提示；不是 Web 独有属性则返回 undefined。
   *
   * hasOwn 守卫与 get() 同理。此前这里是裸 [] 索引，'toString' 会返回一个函数；
   * 唯一的调用方 webOnlyFixFor 用 `typeof hint === 'string'` 挡住了，所以不是活
   * bug——守卫收到上游之后，那道 typeof 从「承重」降为「双保险」。
   */
  webOnlyHint(prop: string): string | undefined {
    return Object.hasOwn(this.data.webOnly, prop) ? this.data.webOnly[prop] : undefined;
  }

  allProperties(): readonly string[] {
    return Object.keys(this.data.properties);
  }

  functions(): readonly FunctionInfo[] {
    return this.data.functions;
  }

  atRule(name: string): AtRuleInfo | undefined {
    return Object.hasOwn(this.data.atRules, name) ? this.data.atRules[name] : undefined;
  }

  /**
   * 全部 at-rule 名。为 MCP 的「列出全部已知条目」加——那边不该为了取一份
   * 名单去摸私有字段（types 层拿不到 data，只能 cast，而 cast 一旦遇上
   * 重构就是静默 undefined）。
   */
  allAtRules(): readonly string[] {
    return Object.keys(this.data.atRules);
  }

  pseudoClasses(): readonly string[] {
    return this.data.pseudoClasses;
  }
}
