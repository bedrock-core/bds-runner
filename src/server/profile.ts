import fs from 'node:fs/promises';
import path from 'node:path';
import type { BdsServer } from './process';

export interface ScriptProfile {
  /** Directory containing the native captures and their manifest. */
  directory: string;
  cpuProfiles: string[];
  diagnostics: string[];
}

/** Orchestrate Bedrock's native console profiler and diagnostics; sampling runs inside BDS. */
export class ScriptProfiler {
  private transcriptStart = 0;
  private active = false;

  constructor(private readonly server: Pick<BdsServer, 'send' | 'exited' | 'transcript'>, private readonly serverDir: string, private readonly outputDir: string) {}

  private async files(): Promise<Map<string, string>> {
    const roots = [path.join(this.serverDir, 'logs'), path.join(this.serverDir, 'profiles'), path.join(this.serverDir, 'diagnostics')];

    if (process.env.APPDATA) { roots.push(path.join(process.env.APPDATA, 'Minecraft Bedrock Server', 'logs', 'profiles'), path.join(process.env.APPDATA, 'Minecraft Bedrock Server', 'logs', 'diagnostics')); }

    const result = new Map<string, string>();

    const lines = this.server.transcript.slice(this.transcriptStart).split(/\r?\n/).filter(line => !line.includes('[Scripting]'));

    for (const line of lines) {
      const reported = /(?:Profiler stopped\. Profile saved to|Diagnostics capture stopped - saved to)\s*['"](.+\.(?:cpuprofile|mcstats))['"]\s*$/i.exec(line)?.[1];

      if (!reported) { continue; }

      const file = path.resolve(this.serverDir, reported);
      const contained = roots.some((root) => {
        const relative = path.relative(root, file);

        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      });

      if (!contained) { throw new Error(`Native capture path is outside the server's log directories: ${file}`); }

      try {
        const stat = await fs.stat(file);

        if (stat.isFile() && stat.size > 0) { result.set(file, `${stat.size}:${stat.mtimeMs}`); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
      }
    }

    return result;
  }

  async start(): Promise<void> {
    if (this.active) { throw new Error('Script profiling is already active'); }

    this.transcriptStart = this.server.transcript.length;
    this.server.send('script profiler start');
    this.server.send('script diagnostics startcapture');
    this.active = true;
  }

  async stop(): Promise<ScriptProfile> {
    if (!this.active) { throw new Error('Script profiling is not active'); }

    this.active = false;

    if (!this.server.exited) {
      this.server.send('script profiler stop');
      this.server.send('script diagnostics stopcapture');
    }

    await fs.mkdir(this.outputDir, { recursive: true });
    const result: ScriptProfile = { directory: path.resolve(this.outputDir), cpuProfiles: [], diagnostics: [] };
    const deadline = Date.now() + 15000;
    let candidates = new Map<string, string>();
    let stable = 0;

    while (Date.now() < deadline) {
      const current = await this.files();
      const complete = [...current.keys()].some(file => file.endsWith('.cpuprofile')) && [...current.keys()].some(file => file.endsWith('.mcstats'));

      stable = complete && JSON.stringify([...current]) === JSON.stringify([...candidates]) ? stable + 1 : 0;
      candidates = current;

      if (stable >= 3) { break; }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (stable < 3) { throw new Error(`Native capture files did not finish writing; see ${result.directory}`); }

    for (const [index, file] of [...candidates.keys()].entries()) {
      const destination = path.join(result.directory, `${index + 1}-${path.basename(file)}`);

      await fs.copyFile(file, destination);
      (file.endsWith('.cpuprofile') ? result.cpuProfiles : result.diagnostics).push(destination);
    }

    await fs.writeFile(path.join(result.directory, 'captures.json'), `${JSON.stringify(result, null, 2)}\n`);

    if (!result.cpuProfiles.length || !result.diagnostics.length) { throw new Error(`Native profiling did not produce both .cpuprofile and .mcstats captures; see ${result.directory}`); }

    return result;
  }
}
