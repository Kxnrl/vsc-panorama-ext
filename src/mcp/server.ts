import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkg from '../../package.json';
import type { McpEnv, McpServices } from './env';
import { WorkspaceScanner, querySymbols } from './tools/symbols';
import { validateFile } from './tools/validate';
import { applyFixes } from './tools/fix';
import { panelInfo, propertyInfo } from './tools/reference';
import { listWorkspaces, WorkspaceRegistry } from './tools/workspaces';
import rawPanels from '../../data/panels.json';
import rawProperties from '../../data/vcss-properties.json';
import rawObservedValues from '../../data/vcss-observed-values.json';
import rawObservedAttributes from '../../data/vxml-observed-attributes.json';
import rawAttributeValues from '../../data/vxml-attribute-values.json';

export const SERVER_NAME = 'cs2-panorama';

/**
 * 工具名刻意不带 panorama_ 前缀：主流客户端（含 Claude Code）会把服务器名
 * 拼进工具全名（cs2-panorama__validate），前缀写两遍就是
 * cs2-panorama__panorama_validate。
 */

/**
 * 装配完整的 MCP server。每次 HTTP 请求新建一个 McpServer 实例
 * （Streamable HTTP 的 stateless 模式），但 services 与 scanner 由调用方
 * 持有、跨请求共享——注册表只读，scanner 的 TTL 缓存是进程级资产，
 * 按请求重建缓存等于没有缓存。
 */
export function buildMcpServer(
  env: McpEnv,
  services: McpServices,
  scanner: WorkspaceScanner,
  registry?: WorkspaceRegistry,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: pkg.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const json = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  });

  server.registerTool(
    'validate',
    {
      description: services.msg.mcp.toolValidateDesc(),
      inputSchema: {
        path: z.string().describe('Absolute path of the .xml/.vxml layout or .css/.vcss stylesheet'),
        root: z.string().optional().describe('Workspace root for cross-file checks; omitted = auto-detect'),
      },
    },
    async ({ path, root }) => json(validateFile({ path, root }, env, services, scanner)),
  );

  server.registerTool(
    'panel_info',
    {
      description: services.msg.mcp.toolPanelInfoDesc(),
      inputSchema: {
        panel: z.string().optional().describe('Panel type name, e.g. Label; omitted = list all'),
      },
    },
    async ({ panel }) => json(panelInfo({ panel }, services.panels, services.msg.mcp.noteDataIncomplete)),
  );

  server.registerTool(
    'property_info',
    {
      description: services.msg.mcp.toolPropertyInfoDesc(),
      inputSchema: {
        name: z.string().optional().describe('Property / function / at-rule name; omitted = list all'),
      },
    },
    async ({ name }) => json(propertyInfo({ name }, services.props, services.msg.mcp.noteDataIncomplete)),
  );

  server.registerTool(
    'symbols',
    {
      description: services.msg.mcp.toolSymbolsDesc(),
      inputSchema: {
        root: z.string().describe('Workspace or content root to scan'),
        kind: z.enum(['class', 'id', 'define', 'keyframe']),
        name: z.string().optional().describe('Symbol name; omitted = list all names of this kind'),
        refresh: z.boolean().optional().describe('Force a rescan, bypassing the cache'),
      },
    },
    async ({ root, kind, name, refresh }) =>
      json(querySymbols({ root, kind, name, refresh }, scanner, services.msg.mcp.errRootNotDir)),
  );

  server.registerTool(
    'apply_fixes',
    {
      description: services.msg.mcp.toolApplyFixesDesc(),
      inputSchema: {
        path: z.string().describe('Absolute path of the file to fix (edited in place)'),
        root: z.string().optional().describe('Workspace root for cross-file checks; omitted = auto-detect'),
        ruleIds: z.array(z.string()).optional().describe('Restrict to these rule ids; omitted = all fixable, an empty list applies none'),
        dryRun: z.boolean().optional().describe('Compute the fixes without writing the file'),
      },
    },
    async ({ path, root, ruleIds, dryRun }) =>
      json(applyFixes({ path, root, ruleIds, dryRun }, env, services, scanner)),
  );

  server.registerTool(
    'workspaces',
    {
      description: services.msg.mcp.toolWorkspacesDesc(),
      inputSchema: {},
    },
    async () => json(listWorkspaces(registry)),
  );

  registerDataResources(server, services);
  registerPrompts(server, services);

  return server;
}

const DATA_RESOURCES = [
  { name: 'panels', uri: 'panorama://data/panels', data: rawPanels },
  { name: 'properties', uri: 'panorama://data/properties', data: rawProperties },
  { name: 'observed-values', uri: 'panorama://data/observed-values', data: rawObservedValues },
  { name: 'observed-attributes', uri: 'panorama://data/observed-attributes', data: rawObservedAttributes },
  { name: 'attribute-values', uri: 'panorama://data/attribute-values', data: rawAttributeValues },
] as const;

function registerDataResources(server: McpServer, services: McpServices): void {
  for (const r of DATA_RESOURCES) {
    server.registerResource(
      r.name,
      r.uri,
      { mimeType: 'application/json', description: services.msg.mcp.resourceDataDesc() },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(r.data, null, 2) }],
      }),
    );
  }
}

/**
 * Prompt 的**描述**走 i18n 目录（prompt*Desc 三条）——它是用户在客户端里
 * 看到的元数据；**模板正文**刻意只用英文：正文是给模型的操作指令，英文指令
 * 的遵循度最稳，发起后模型再用用户的语言回答。这就是两边语言策略的分界。
 */
function registerPrompts(server: McpServer, services: McpServices): void {
  server.registerPrompt(
    'review_file',
    {
      description: services.msg.mcp.promptReviewDesc(),
      argsSchema: {
        path: z.string().describe('Absolute path of the file to review'),
        root: z.string().optional().describe('Workspace root for cross-file checks'),
      },
    },
    ({ path, root }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Review the Counter-Strike 2 Panorama file ${path}${root ? ` (workspace root ${root})` : ''}:\n` +
              '0. If unsure which Panorama workspaces exist, call workspaces first and pick the root ' +
              'that contains this file — never guess directories by scanning parents.\n' +
              '1. Call the validate tool on it.\n' +
              '2. Call apply_fixes to clear every deterministic fix mechanically (visibility: hidden, ' +
              '@keyframes quoting, box-shadow order, transition shorthand, closing tags, Button text, ' +
              'binding prefixes).\n' +
              '3. For what remains, decide yourself using the panel_info and property_info tools — ' +
              'Panorama looks like web CSS but is not web CSS, do not answer from memory. A rule marked ' +
              'as "not in the known list" is NOT proof of invalidity: the reference data is incomplete, ' +
              'keep constructs you cannot disprove.\n' +
              '4. Re-validate. Repeat until no provable issue remains.\n' +
              'Never silence a rule or edit unrelated lines. Report what you changed and what you kept.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'web_to_panorama',
    {
      description: services.msg.mcp.promptWebConvertDesc(),
      argsSchema: {
        declarations: z.string().describe('The web CSS declarations to convert'),
      },
    },
    ({ declarations }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Convert these web CSS declarations to Panorama VCSS:\n${declarations}\n\n` +
              'For every name, look it up with the property_info tool first — do not answer from memory. ' +
              'If it is web-only, use the replacement the tool suggests; if it is unknown, say so explicitly ' +
              'instead of guessing. Present the result as a VCSS rule body, then list each difference from ' +
              'web CSS in one line (name change, value-domain change, units, shorthand pitfalls).',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'scaffold_layout',
    {
      description: services.msg.mcp.promptScaffoldDesc(),
      argsSchema: {
        name: z.string().describe('Base name for the new files, e.g. score_panel'),
        directory: z.string().describe('Absolute directory where the files should be created'),
        custom_hud: z.boolean().optional().describe('Target lives under layout/custom_game/ (strict mode)'),
      },
    },
    ({ name, directory, custom_hud }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Create a Panorama layout + stylesheet pair named ${name} in ${directory}.\n` +
              (custom_hud
                ? 'Target is a CustomHudLayout (custom_game): only <Panel> <Label> <Image> <Button> are allowed, ' +
                  'attributes are whitelisted (Panel: id/class/hittest, Label: +text, Image: +src/texturewidth/textureheight, ' +
                  'Button: id/class only, text goes in a child Label), no <scripts>, no snippets, no inline style=, ' +
                  'only {s:} bindings. Styling itself is unrestricted VCSS.\n'
                : 'Full Panorama mode: any of the 245 panel types, all binding kinds available. ' +
                  'Check panel_info before using a less common panel type.\n') +
              'Write layout/custom_game style paths as s2r:// URIs in <styles><include>. ' +
              'After writing both files, run validate on the layout and fix anything it reports.',
          },
        },
      ],
    }),
  );
}
