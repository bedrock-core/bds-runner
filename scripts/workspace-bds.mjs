/** Configure per-repository BDS instances and local-only firewall rules. No servers are launched. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const directory = path.dirname(fileURLToPath(import.meta.url));
const { validateInstanceName } = await createJiti(import.meta.url).import('../src/bds/paths.ts');

async function json(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') { return undefined; }

    throw error;
  }
}

function portPair(port, source) {
  if (!Number.isInteger(port) || port < 1024 || port > 65534) { throw new Error(`${source}: choose a port from 1024 to 65534, followed by its IPv6 port.`); }

  return [port, port + 1];
}

/** Existing assignments are retained; new repositories receive the first free pair in the range. */
export async function createPlan(root, { firstPort = 19780, lastPort = 19819 } = {}) {
  root = await fs.realpath(root);
  portPair(firstPort, 'Port range');

  if (!Number.isInteger(lastPort) || lastPort > 65535 || lastPort <= firstPort) { throw new Error('Invalid UDP port range.'); }

  const projects = [];
  const occupied = new Map();

  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) { continue; }

    const repository = path.join(root, entry.name);
    const file = path.join(repository, 'bds-runner.json');
    const current = await json(file);
    const pkg = await json(path.join(repository, 'package.json'));
    const gameTests = Object.entries(pkg?.scripts ?? {}).some(([name, command]) => name.startsWith('test:mc')
      || /acceptance.*native/.test(name) || /bc-bds\s+run/.test(command));

    if (!current && !gameTests) { continue; }

    // Worktrees opt in with an explicit root config; routine setup targets the main checkouts.
    if (!current && (await fs.lstat(path.join(repository, '.git')).catch(() => undefined))?.isFile()) { continue; }

    const config = { $schema: './.bds/schema/bds-runner.json', version: 'latest', channel: 'stable', ...current };
    const instances = config.instances ?? {};

    if (!instances || typeof instances !== 'object' || Array.isArray(instances)) { throw new Error(`${file}: instances must map names to UDP ports.`); }

    for (const [name, port] of Object.entries(instances)) {
      validateInstanceName(name);

      for (const number of portPair(port, file)) {
        if (occupied.has(number)) { throw new Error(`UDP port ${number} is assigned to both ${occupied.get(number)} and ${entry.name}/${name}.`); }

        occupied.set(number, `${entry.name}/${name}`);
      }
    }

    projects.push({ name: entry.name, repository, file, config, instances });
  }

  if (projects.length === 0) { throw new Error('No repositories with bds-runner.json or GameTest commands were found.'); }

  for (const project of projects) {
    if (Object.keys(project.instances).length === 0) {
      const name = project.config.instance ?? 'gametest';

      validateInstanceName(name);
      let port = firstPort;

      while (port + 1 <= lastPort && (occupied.has(port) || occupied.has(port + 1))) { port += 2; }

      if (port + 1 > lastPort) { throw new Error('The UDP port range has no free pair for ' + project.name); }

      project.instances[name] = port;
      occupied.set(port, `${project.name}/${name}`);
      occupied.set(port + 1, `${project.name}/${name}`);
    }

    const names = Object.keys(project.instances);

    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) { throw new Error('Instance names must be unique on Windows and Linux.'); }

    project.config.instance ??= names[0];

    if (typeof project.config.instance !== 'string') { throw new Error(`${project.file}: instance must be a name.`); }

    validateInstanceName(project.config.instance);

    if (!Object.hasOwn(project.instances, project.config.instance)) { throw new Error(`${project.file}: the default instance must be declared.`); }

    project.config.instances = project.instances;
    project.config.properties = { ...project.config.properties, 'server-ip': '127.0.0.1', 'enable-lan-visibility': false };
  }

  const executables = new Set();

  for (const project of projects) {
    const server = path.join(project.repository, '.bds/server');

    for (const name of Object.keys(project.instances)) { executables.add(path.join(server, name, 'bedrock_server.exe')); }

    const entries = await fs.readdir(server, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') { return []; }

      throw error;
    });

    for (const instance of entries) {
      if (!instance.isDirectory() || instance.isSymbolicLink()) { continue; }

      for (const file of await fs.readdir(path.join(server, instance.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.toLowerCase().endsWith('.exe')) { executables.add(path.join(server, instance.name, file.name)); }
      }
    }
  }

  const rules = [...executables].sort().map(program => ({
    name: 'BedrockCore-' + createHash('sha256').update(program.toLowerCase()).digest('hex').slice(0, 24),
    program,
  }));
  const ports = [...occupied.keys()].sort((a, b) => a - b);

  return { root, policy: 'local-only', projects, rules, ports,
    linuxTable: 'bedrock_core_' + createHash('sha256').update(root).digest('hex').slice(0, 12) };
}

/** A dedicated table blocks external traffic to the assigned ports without replacing host policy. */
export function linuxRules(plan) {
  return `add table inet ${plan.linuxTable}\nflush table inet ${plan.linuxTable}\n`
    + `table inet ${plan.linuxTable} {\n  chain input {\n    type filter hook input priority 0; policy accept;\n`
    + `    iifname != "lo" meta l4proto { tcp, udp } th dport { ${plan.ports.join(', ')} } drop\n  }\n}\n`;
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, ...options });

  if (result.error) { throw result.error; }

  if (result.status !== 0) { throw new Error(`${command} exited with ${result.status}`); }
}

export async function applyPlan(plan, { platform = process.platform, executeCommand = execute } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bedrock-core-bds-setup-'));

  try {
    if (platform === 'win32') {
      const file = path.join(temporary, 'plan.json');

      await fs.writeFile(file, JSON.stringify(plan));
      executeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(directory, 'workspace-firewall.ps1'), '-Plan', file]);
    } else if (platform === 'linux') {
      executeCommand('nft', ['-c', '-f', '-'], { input: linuxRules(plan) });
      executeCommand('nft', ['-f', '-'], { input: linuxRules(plan) });
    } else { throw new Error('BDS workspace setup supports Windows and Linux.'); }

    for (const project of plan.projects) {
      const original = await fs.readFile(project.file, 'utf8').catch(() => '');
      const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? '  ';

      await fs.writeFile(project.file, JSON.stringify(project.config, null, indent) + '\n');
    }
  } finally {
    const relative = path.relative(os.tmpdir(), temporary);

    if (!relative.startsWith('bedrock-core-bds-setup-') || relative.includes(path.sep)) { throw new Error('Unexpected setup temporary directory.'); }

    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let root = path.resolve(directory, '../..');
  let apply = false;
  let printLinux = false;
  let firstPort = 19780;
  let lastPort = 19819;

  while (args.length) {
    const arg = args.shift();

    if (arg === '--root' && args[0]) { root = path.resolve(args.shift()); } else if (arg === '--apply') { apply = true; } else if (arg === '--nft') { printLinux = true; } else if (arg === '--dry-run') { /* The default is a read-only preview. */ } else if (arg === '--ports' && /^\d+-\d+$/.test(args[0] ?? '')) { [firstPort, lastPort] = args.shift().split('-').map(Number); } else if (arg === '--help') {
      process.stdout.write('workspace-bds [--root <multi-repo directory>] [--ports <first-last>] [--apply|--nft]\n'
        + 'Without --apply, prints the project configs and firewall plan. --apply requires Administrator/root.\n');

      return;
    } else { throw new Error('Usage: workspace-bds [--root <directory>] [--ports <first-last>] [--apply|--nft]'); }
  }

  const plan = await createPlan(root, { firstPort, lastPort });

  if (printLinux) {
    if (apply) { throw new Error('--nft previews Linux rules; use --apply separately.'); }

    process.stdout.write(linuxRules(plan));

    return;
  }

  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');

  if (apply) { await applyPlan(plan); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
