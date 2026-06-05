import { program } from 'commander';
import { request, health, ensureServer, getBridgeUrl, setGlobalOpts, resolveConfig, pairWithServer, saveConfig, loadConfigFile, resetConfig, isLocalServer } from './client.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

function out(data: unknown) {
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

program
  .name('browser-bridge-cli')
  .version('0.1.0')
  .description('Browser Bridge CLI')
  .option('-s, --server <url>', 'Bridge server URL')
  .option('--token <token>', 'Authentication token')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.server || opts.token) {
      setGlobalOpts({ server: opts.server, token: opts.token });
    }
  });

program
  .command('info')
  .description('Check bridge server status')
  .action(async () => {
    await ensureServer();
    const config = resolveConfig(program.opts());
    const h = await fetch(`${config.url}/api/health`, {
      headers: config.token ? { 'X-Browser-Bridge': config.token } : {},
    }).then(r => r.json());
    out(h);
  });

program
  .command('eval <expression>')
  .description('Execute JS expression in active tab')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('-k, --keep-attached', 'Keep debugger attached')
  .action(async (expression: string, opts) => {
    const result = await request('eval', { expression, tabId: opts.tab, keepAttached: opts.keepAttached });
    out(result);
  });

program
  .command('eval-file <file>')
  .description('Execute JS file in active tab')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('-k, --keep-attached', 'Keep debugger attached')
  .action(async (file: string, opts) => {
    const code = fs.readFileSync(path.resolve(file), 'utf-8');
    const result = await request('eval.file', { code, tabId: opts.tab, keepAttached: opts.keepAttached });
    out(result);
  });

program
  .command('query <selector>')
  .description('Query DOM elements')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('-l, --limit <n>', 'Max results', parseInt)
  .option('-k, --keep-attached', 'Keep debugger attached')
  .action(async (selector: string, opts) => {
    const result = await request('query', {
      selector,
      tabId: opts.tab,
      limit: opts.limit,
      keepAttached: opts.keepAttached,
    });
    out(result);
  });

program
  .command('tabs')
  .description('List all tabs')
  .action(async () => {
    const tabs = await request('tabs.list') as Array<Record<string, unknown>>;
    for (const t of tabs) {
      const marker = t.active ? '*' : ' ';
      console.log(`${marker} [${t.id}] ${t.title}`);
      console.log(`        ${t.url}`);
    }
  });

program
  .command('tab <id>')
  .description('Get tab info')
  .action(async (id: string) => {
    const result = await request('tabs.get', { tabId: parseInt(id) });
    out(result);
  });

program
  .command('activate <id>')
  .description('Switch to a tab (no focus steal)')
  .action(async (id: string) => {
    await request('tabs.activate', { tabId: parseInt(id) });
    console.log(`Activated tab ${id}`);
  });

program
  .command('new-tab [url]')
  .description('Create a new tab')
  .action(async (url?: string) => {
    const result = await request('tabs.create', { url }) as Record<string, unknown>;
    console.log(`Created tab ${result.id}: ${result.url}`);
  });

program
  .command('close-tab <id>')
  .description('Close a tab')
  .action(async (id: string) => {
    await request('tabs.close', { tabId: parseInt(id) });
    console.log(`Closed tab ${id}`);
  });

program
  .command('cdp <method> [params]')
  .description('Send raw CDP command')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('-k, --keep-attached', 'Keep debugger attached')
  .action(async (method: string, paramsJson: string | undefined, opts: { tab?: number; keepAttached?: boolean }) => {
    const params = paramsJson ? JSON.parse(paramsJson) : {};
    const result = await request('cdp', { method, params, tabId: opts.tab, keepAttached: opts.keepAttached });
    out(result);
  });

program
  .command('detach')
  .description('Detach debugger from tab (removes warning bar)')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (opts) => {
    await request('cdp.detach', { tabId: opts.tab });
    console.log('Detached');
  });

program
  .command('navigate <url>')
  .description('Navigate active tab to URL')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (url: string, opts) => {
    await request('navigate', { url, tabId: opts.tab });
    console.log(`Navigated to ${url}`);
  });

program
  .command('reload')
  .description('Reload active tab')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('--no-cache', 'Bypass cache')
  .action(async (opts) => {
    await request('reload', { tabId: opts.tab, bypassCache: !opts.cache });
    console.log('Reloaded');
  });

program
  .command('screenshot')
  .description('Capture screenshot')
  .option('-o, --output <file>', 'Output file', 'screenshot.png')
  .option('-f, --full', 'Full page screenshot')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (opts) => {
    const action = opts.full ? 'screenshot.full' : 'screenshot';
    const result = (await request(action, { tabId: opts.tab })) as { dataUrl: string };
    const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(opts.output, Buffer.from(base64, 'base64'));
    console.log(`Saved to ${opts.output}`);
  });

program
  .command('pdf')
  .description('Export page as PDF')
  .option('-o, --output <file>', 'Output file', 'page.pdf')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (opts) => {
    const result = (await request('pdf', { tabId: opts.tab })) as { dataBase64: string };
    fs.writeFileSync(opts.output, Buffer.from(result.dataBase64, 'base64'));
    console.log(`Saved to ${opts.output}`);
  });

program
  .command('network')
  .description('Get captured network requests')
  .option('-l, --limit <n>', 'Max entries', parseInt)
  .option('--clear', 'Clear network log')
  .action(async (opts) => {
    if (opts.clear) {
      await request('network.clear');
      console.log('Network log cleared');
      return;
    }
    const result = await request('network.getAll', { limit: opts.limit });
    out(result);
  });

program
  .command('cookies')
  .description('Get cookies')
  .option('-u, --url <url>', 'Filter by URL')
  .option('-d, --domain <domain>', 'Filter by domain')
  .option('-n, --name <name>', 'Filter by name')
  .action(async (opts) => {
    const filter: Record<string, string> = {};
    if (opts.url) filter.url = opts.url;
    if (opts.domain) filter.domain = opts.domain;
    if (opts.name) filter.name = opts.name;
    const result = await request('cookies.get', { filter });
    out(result);
  });

program
  .command('pair')
  .description('Pair with bridge server')
  .option('-n, --name <name>', 'Client name')
  .action(async (opts) => {
    const parentOpts = program.opts();
    const serverUrl = parentOpts.server || process.env.BROWSER_BRIDGE_URL || loadConfigFile().server;

    if (serverUrl && !isLocalServer(serverUrl)) {
      const code = await prompt('Enter pairing code: ');
      if (!code || code.length !== 6) {
        console.error('Invalid code. Must be 6 digits.');
        process.exit(1);
      }
      const result = await pairWithServer(serverUrl, code, opts.name);
      saveConfig({ server: serverUrl, token: result.token, name: result.name });
      console.log(`Paired as "${result.name}". Config saved.`);
      return;
    }

    const result = await request('pair.request') as { code: string };
    console.log(`\n  Pairing code: ${result.code}\n`);
    console.log('Enter this code in the extension popup to pair.');
    console.log('Code expires in 5 minutes.');
  });

program
  .command('unpair')
  .description('Remove stored remote server credentials')
  .action(async () => {
    const config = loadConfigFile();
    if (!config.token && !config.server) {
      console.log('No remote config to clear.');
      return;
    }
    if (config.token && config.name) {
      try {
        await request('token.revoke', { name: config.name });
        console.log('Server token revoked.');
      } catch {
        console.log('Could not reach server to revoke token (cleared locally only).');
      }
    }
    saveConfig({ token: undefined, server: undefined, name: undefined });
    console.log('Remote credentials cleared.');
  });

program
  .command('disable')
  .description('Disable extension (disconnect)')
  .action(async () => {
    await request('disable');
    console.log('Extension disabled');
  });

program
  .command('whitelist')
  .description('View whitelist (manage from popup)')
  .action(async () => {
    const result = await request('whitelist.get');
    out(result);
  });

program
  .command('clients')
  .description('List connected clients')
  .action(async () => {
    const result = await request('client.list') as Array<Record<string, unknown>>;
    for (const c of result) {
      const marker = c.active ? '*' : ' ';
      const paired = c.paired ? 'paired' : 'unpaired';
      console.log(`${marker} [${c.id}] ${c.name} (${paired})`);
    }
  });

program
  .command('switch <clientId>')
  .description('Switch active client')
  .action(async (clientId: string) => {
    await request('client.switch', { clientId });
    console.log(`Switched to client ${clientId}`);
  });

// --- config subcommand ---

const configCmd = program.command('config').description('Manage CLI configuration');

configCmd
  .command('get')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfigFile();
    if (Object.keys(config).length === 0) {
      console.log('No config set. Using defaults (local server).');
      return;
    }
    const masked = { ...config };
    if (masked.token) masked.token = masked.token.slice(0, 8) + '...';
    out(masked);
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value (server, token, name)')
  .action((key: string, value: string) => {
    if (!['server', 'token', 'name'].includes(key)) {
      console.error(`Unknown config key: ${key}. Valid: server, token, name`);
      process.exit(1);
    }
    saveConfig({ [key]: value });
    const display = key === 'token' ? value.slice(0, 8) + '...' : value;
    console.log(`Set ${key} = ${display}`);
  });

configCmd
  .command('reset')
  .description('Clear all configuration')
  .action(() => {
    resetConfig();
    console.log('Config cleared.');
  });

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
