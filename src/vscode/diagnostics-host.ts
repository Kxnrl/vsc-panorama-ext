import * as vscode from 'vscode';
import { parseVxml } from '../core/vxml/parser';
import { parseVcss } from '../core/vcss/parser';
import { applySettings, diagnoseVcss, diagnoseVxml } from '../core/diagnostics';
import {
  ALLOWED_LEVELS,
  DEFAULT_DIAGNOSTIC_SETTINGS,
  SETTING_KEYS,
  type Diagnostic as CoreDiagnostic,
  type DiagnosticSettings,
  type Severity,
} from '../core/diagnostics/types';
import { PanelRegistry } from '../core/data/panels';
import { PropertyRegistry } from '../core/data/properties';
import { LOCALE } from './locale';
import { messagesFor } from '../core/i18n';
import { ObservedAttributes } from '../core/data/observed-attributes';
import { DEFAULT_CUSTOM_HUD_PATTERNS, layoutModeFor } from '../core/mode';
import type { WorkspaceIndex } from '../core/index/workspace-index';

/** 与索引宿主同一档：两处都是「用户还在敲」时不做重活 */
const DEBOUNCE_MS = 300;

const panels = PanelRegistry.load(LOCALE);
const props = PropertyRegistry.load(LOCALE);
const MSG = messagesFor(LOCALE);
const observed = ObservedAttributes.load();

const SEVERITY: Readonly<Record<Severity, vscode.DiagnosticSeverity>> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  hint: vscode.DiagnosticSeverity.Hint,
};

/**
 * 读七个开关。取值非法（用户手改 settings.json 写了别的字符串）时回落到默认
 * 级别而不是整组关掉——静默关掉一整组规则比用一个不对的级别更坏。
 *
 * **合法取值按键查 `ALLOWED_LEVELS`，不是一张全局表**（最终评审 M-6）。交付时
 * 这里是 `const LEVELS = ['off','hint','warning','error']`，七个键共用，于是手改
 * settings.json 写 `"panorama.diagnostics.unknownProperty": "error"` 会被照单接受
 * ——而 `package.json` 给这个键声明的 `enum` 只到 `warning`，设置界面的下拉框里
 * 根本没有 error 这一项。「取值非法就回落到默认」这句注释在那一档上并不成立。
 */
export function readDiagnosticSettings(): DiagnosticSettings {
  const cfg = vscode.workspace.getConfiguration('panorama');
  const out: Record<string, Severity | 'off'> = {};
  for (const key of SETTING_KEYS) {
    const fallback = DEFAULT_DIAGNOSTIC_SETTINGS[key];
    const raw = cfg.get<string>(`diagnostics.${key}`, fallback);
    const allowed: readonly string[] = ALLOWED_LEVELS[key];
    out[key] = (allowed.includes(raw) ? raw : fallback) as Severity | 'off';
  }
  return out as DiagnosticSettings;
}

function isPanoramaDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'panorama-vxml' || doc.languageId === 'panorama-vcss';
}

function modeOf(doc: vscode.TextDocument) {
  const patterns = vscode.workspace
    .getConfiguration('panorama')
    .get<string[]>('customHudLayout.include', [...DEFAULT_CUSTOM_HUD_PATTERNS]);
  return layoutModeFor(doc.uri.fsPath, patterns);
}

/**
 * core 层的诊断带的是**文档绝对字符偏移**（规格：行列转换只在适配层做）。
 * 这里是全项目唯一一处偏移 -> 行列的换算。
 */
export function toVscode(doc: vscode.TextDocument, d: CoreDiagnostic): vscode.Diagnostic {
  // positionAt 是 VSCode 自己的行列换算，与编辑器缓冲区逐字一致。绝不能自己
  // 数换行——文档里的换行形态、代理对都会让手写的换算与编辑器错位。
  const range = new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end));
  const message = d.fix ? `${d.message}\n${d.fix}` : d.message;
  const out = new vscode.Diagnostic(range, message, SEVERITY[d.severity]);
  out.source = 'panorama';
  out.code = d.ruleId;
  return out;
}

/**
 * 某文档此刻的 core 诊断（已过配置开关，保留 edits 字段）。
 * 诊断宿主与灯泡 provider 共用这一份计算——两处各算一遍，
 * 「波浪线说有、灯泡说没有」这种分叉迟早出现。
 */
export function coreDiagnosticsFor(doc: vscode.TextDocument, index: WorkspaceIndex): CoreDiagnostic[] {
  const uri = doc.uri.fsPath.replace(/\\/g, '/');
  const text = doc.getText();
  const raw =
    doc.languageId === 'panorama-vxml'
      ? diagnoseVxml(parseVxml(text), {
          uri, mode: modeOf(doc), panels, observed, index, msg: MSG,
        })
      : diagnoseVcss(parseVcss(text), { uri, props, index, msg: MSG });
  return applySettings(raw, readDiagnosticSettings());
}

export function createDiagnosticsHost(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
): vscode.DiagnosticCollection {
  const collection = vscode.languages.createDiagnosticCollection('panorama');
  context.subscriptions.push(collection);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const compute = (doc: vscode.TextDocument): void => {
    if (!isPanoramaDocument(doc)) return;
    collection.set(doc.uri, coreDiagnosticsFor(doc, index).map((d) => toVscode(doc, d)));
  };

  const schedule = (doc: vscode.TextDocument): void => {
    if (!isPanoramaDocument(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        compute(doc);
      }, DEBOUNCE_MS),
    );
  };

  const forget = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    // **先清挂起的定时器**：只 delete 诊断的话，关闭之前那次编辑排下的队
    // 仍会在 300ms 后触发 compute()，把诊断原样写回去——编辑器里就出现
    // 「已经关掉的文件仍挂着诊断」。这与 M3 索引宿主里 drop() 忘记清定时器
    // 导致「删除被防抖静默撤销」是同一个陷阱，只是方向反过来。
    clearTimeout(timers.get(key));
    timers.delete(key);
    collection.delete(doc.uri);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(compute),
    vscode.workspace.onDidCloseTextDocument(forget),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
  );

  // 索引变化 / 配置变化 -> 重算**当前打开着的**文档。跨文件规则的结论取决于
  // 索引内容，不重算就会一直显示过期的「未定义」。两条路径共用**同一个**防抖
  // 定时器：全量扫描会连发几百次通知，逐次重算所有打开文档没有意义；配置变化
  // 虽然不成串，但走同一条路，「关闭 / dispose 时要清干净」这件事就只需要在一
  // 个地方做对，不必再养一个同型的竞态。
  let bulkTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAll = (): void => {
    clearTimeout(bulkTimer);
    bulkTimer = setTimeout(() => {
      bulkTimer = undefined;
      // 取当前的 textDocuments 而不是记一份快照：此刻已经关掉的文档不在
      // 里面，于是不会被重新写上诊断。
      for (const doc of vscode.workspace.textDocuments) compute(doc);
    }, DEBOUNCE_MS);
  };

  context.subscriptions.push(index.onDidChange(scheduleAll));

  // 七个诊断开关与 customHudLayout.include 都是「改完要立刻见效」的东西。少了
  // 这个监听器，用户把某一组关掉之后**已经打开着的文件波浪线纹丝不动**，直到
  // 他去每个文件里随手敲一下——默认 hint 的 unknownClass 在语料上有 793 处命中，
  // 恰恰是最可能被关的一组，于是头号交付物在最常见的使用姿势下看起来是坏的。
  // affectsConfiguration 这道过滤不能省：否则用户改个字号也要把所有打开的文档
  // 重跑一遍诊断。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('panorama.diagnostics') ||
        e.affectsConfiguration('panorama.customHudLayout')
      ) {
        scheduleAll();
      }
    }),
  );

  // 激活时已经打开着的文档不会再收到 onDidOpenTextDocument
  for (const doc of vscode.workspace.textDocuments) compute(doc);

  context.subscriptions.push({
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      clearTimeout(bulkTimer);
      bulkTimer = undefined;
    },
  });

  return collection;
}
