import type { Command } from 'commander';
import { getActiveClientId, request } from './client.js';

const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
type Call = (action: string, params?: Record<string, unknown>) => Promise<unknown>;
type Group = { id: number; windowId: number; title?: string; color: string; collapsed: boolean };
type Tab = { id: number; groupId: number; index: number };

export function parseId(value: string): number {
  const id = Number(value);
  if (!value.trim() || !Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid ID: ${value}`);
  return id;
}

function tabIds(values: string[]): number[] {
  return [...new Set(values.map(parseId))];
}

async function browser(): Promise<Call> {
  const clientId = await getActiveClientId();
  return (action, params = {}) => request(action, params, clientId);
}

function output(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function properties(opts: { title?: string; color?: string; collapsed?: boolean; expanded?: boolean }) {
  if (opts.color != null && !colors.includes(opts.color)) throw new Error(`Color must be one of: ${colors.join(', ')}`);
  if (opts.collapsed && opts.expanded) throw new Error('Use --collapsed or --expanded, not both');
  return {
    ...(opts.title != null ? { title: opts.title } : {}),
    ...(opts.color != null ? { color: opts.color } : {}),
    ...(opts.collapsed || opts.expanded ? { collapsed: !!opts.collapsed } : {}),
  };
}

function withTabs(group: Group, tabs: Tab[]) {
  return { ...group, tabIds: tabs.filter(tab => tab.groupId === group.id).sort((a, b) => a.index - b.index).map(tab => tab.id) };
}

async function getGroup(call: Call, groupId: number) {
  const [group, tabs] = await Promise.all([call('groups.get', { groupId }), call('tabs.list')]);
  return withTabs(group as Group, tabs as Tab[]);
}

async function list(opts: { window?: number; title?: string; color?: string; collapsed?: boolean; expanded?: boolean }) {
  const filters = properties(opts);
  const call = await browser();
  const [groups, tabs] = await Promise.all([
    call('groups.list', { ...filters, ...(opts.window != null ? { windowId: opts.window } : {}) }), call('tabs.list'),
  ]);
  output((groups as Group[]).map(group => withTabs(group, tabs as Tab[])));
}

export function registerGroupCommands(program: Command) {
  const groups = program.command('groups').description('Manage Chrome/Edge tab groups; IDs belong to the selected browser session');
  groups.action(() => list({}));
  groups.command('list').description('List groups with their tab IDs')
    .option('--window <id>', 'Filter by window ID', parseId)
    .option('--title <pattern>', 'Filter by title pattern')
    .option('--color <color>', colors.join(', '))
    .option('--collapsed', 'Only collapsed groups').option('--expanded', 'Only expanded groups')
    .action(list);

  groups.command('get <id>').description('Get group metadata and member tab IDs')
    .action(async (value: string) => {
      const groupId = parseId(value);
      output(await getGroup(await browser(), groupId));
    });

  groups.command('create <tabIds...>').description('Create a group from existing tabs (empty groups are unsupported)')
    .option('--window <id>', 'Create in this window', parseId)
    .option('--title <title>', 'Group title').option('--color <color>', colors.join(', '))
    .option('--collapsed', 'Collapse the group').option('--expanded', 'Expand the group')
    .action(async (values: string[], opts) => {
      const ids = tabIds(values), update = properties(opts);
      const call = await browser();
      const groupId = await call('tabs.group', { tabIds: ids, ...(opts.window != null ? { createProperties: { windowId: opts.window } } : {}) }) as number;
      if (Object.keys(update).length) {
        try { await call('groups.update', { groupId, properties: update }); }
        catch (error) { throw new Error(`Created group ${groupId}, but updating its properties failed: ${String(error)}`); }
      }
      output(await getGroup(call, groupId));
    });

  groups.command('update <id>').description('Change title, color or collapsed state')
    .option('--title <title>', 'Group title; empty clears it').option('--color <color>', colors.join(', '))
    .option('--collapsed', 'Collapse the group').option('--expanded', 'Expand the group')
    .action(async (value: string, opts) => {
      const groupId = parseId(value), update = properties(opts);
      if (!Object.keys(update).length) throw new Error('Provide --title, --color, --collapsed or --expanded');
      const call = await browser();
      await call('groups.update', { groupId, properties: update });
      output(await getGroup(call, groupId));
    });

  groups.command('delete <id>').description('Dissolve a group while keeping all its tabs open')
    .action(async (value: string) => {
      const groupId = parseId(value), call = await browser();
      const group = await getGroup(call, groupId);
      if (group.tabIds.length) await call('tabs.ungroup', { tabIds: group.tabIds });
      const remaining = await call('groups.list') as Group[];
      if (remaining.some(group => group.id === groupId)) throw new Error('Group membership changed during deletion; inspect the group before retrying');
      output({ id: groupId, ungroupedTabIds: group.tabIds });
    });

  groups.command('add-tabs <id> <tabIds...>').description('Move tabs into an existing group')
    .action(async (value: string, values: string[]) => {
      const groupId = parseId(value), ids = tabIds(values), call = await browser();
      await call('tabs.group', { groupId, tabIds: ids });
      output(await getGroup(call, groupId));
    });

  groups.command('remove-tabs <tabIds...>').description('Ungroup tabs; empty groups disappear automatically')
    .action(async (values: string[]) => {
      const ids = tabIds(values), call = await browser();
      await call('tabs.ungroup', { tabIds: ids });
      output({ tabIds: ids });
    });

  groups.command('move <id>').description('Move a group and all its tabs within or between normal windows')
    .requiredOption('--index <n>', 'Tab-strip index; -1 means the end', Number)
    .option('--window <id>', 'Destination window ID', parseId)
    .action(async (value: string, opts) => {
      const groupId = parseId(value);
      if (!Number.isSafeInteger(opts.index) || opts.index < -1) throw new Error('Index must be an integer greater than or equal to -1');
      const call = await browser();
      const moved = await call('groups.move', { groupId, properties: { index: opts.index, ...(opts.window != null ? { windowId: opts.window } : {}) } }) as Group | undefined;
      output(await getGroup(call, moved?.id ?? groupId));
    });
}
