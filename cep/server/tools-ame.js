/*
 * The Media Encoder tool surface. Same shape as the Premiere one: short
 * commands, machine-readable errors (code: message), guards on the Node side
 * because Node can see the disk and Media Encoder's engine cannot.
 *
 * Guards: every written path is absolute, has an extension, never replaces a
 * file without overwrite:true, and never lands inside a folder listed in
 * AME_MCP_PROTECTED_DIRS; a queue refuses with less than AME_MCP_MIN_FREE_GB
 * (default 15) free on the target disk; a comp whose project reads an
 * expression library is refused, because Media Encoder renders it frozen.
 *
 * Media Encoder's events carry no item id, so a job's state is inferred from
 * its output file plus the batch status and counters, not reported per item.
 */

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const nodePath = require('path');
const { bridgeInfo } = require('./bridge-info.js');
const { checkWritePath, listPresets, freeBytes } = require('./tools-premiere.js');

const PROTECTED_ENV = 'AME_MCP_PROTECTED_DIRS';

const TOOLS = [
  {
    name: 'ame_query',
    description:
      'Read Media Encoder.\n\n' +
      '- sessionInfo: build, batch status, formats, and which Premiere or After Effects bridge carries the calls.\n' +
      '- formats: the format names Media Encoder knows ("H.264", "QuickTime").\n' +
      '- presets: export presets (.epr), filtered by match (e.g. "H264"). Pass the path as preset.\n' +
      '- compItems: projectPath (an .aep) -> the guid of each comp. Media Encoder gives ids only, no names.\n' +
      '- describe: this server\'s live schema for one tool ({tool:"ame_queue"}).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['sessionInfo', 'formats', 'presets', 'compItems', 'describe'] },
        projectPath: { type: 'string' },
        match: { type: 'string' },
        limit: { type: 'number' },
        tool: { type: 'string' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ame_queue',
    description:
      'Queue a job in Media Encoder and return a jobId. Media Encoder renders the SAVED .aep, so save the project ' +
      'first. Refuses with less than AME_MCP_MIN_FREE_GB (default 15) GiB free, never replaces a file without ' +
      'overwrite:true, never writes inside an AME_MCP_PROTECTED_DIRS folder. start:false only queues. Starting runs ' +
      'the whole queue, other items included. Some presets write .mov whatever extension you ask for.\n\n' +
      '- comp: projectPath (.aep), guid (from ame_query compItems), preset (.epr), path (output), optional format, ' +
      'comp (a label for your own reference). Refused with expression_library when the project reads a script or ' +
      'data file through footage(...).sourceData: it would render frozen, so use ae_render in After Effects ' +
      '(allowExpressionLibrary:true overrides).\n' +
      '- file: source (media file), preset, path, optional format.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['comp', 'file'] },
        projectPath: { type: 'string' },
        guid: { type: 'string' },
        comp: { type: 'string' },
        source: { type: 'string' },
        preset: { type: 'string' },
        path: { type: 'string' },
        format: { type: 'string' },
        overwrite: { type: 'boolean' },
        start: { type: 'boolean', description: 'Default true.' },
        allowExpressionLibrary: { type: 'boolean' },
      },
      required: ['command', 'preset', 'path'],
    },
  },
  {
    name: 'ame_batch',
    description:
      'Control the queue. start runs every queued item, pause, stop. clear empties Media Encoder\'s WHOLE queue, ' +
      'yours or not, so it needs all:true.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', enum: ['start', 'pause', 'stop', 'clear'] }, all: { type: 'boolean' } },
      required: ['command'],
    },
  },
  {
    name: 'ame_status',
    description:
      'Follow the queue.\n\n' +
      '- status: Media Encoder\'s batch status and counters plus every job this server queued: queued, encoding, ' +
      'done, failed or cleared, with its output file and size. Events carry no item id, so a job\'s state is ' +
      'inferred from its file.\n' +
      '- finished: jobs whose output is complete (file present, size unchanged over a second, Media Encoder not ' +
      'still writing it), with sha256 and size.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', enum: ['status', 'finished'] }, jobId: { type: 'string' } } },
  },
  {
    name: 'ame_diagnostics',
    description:
      'health (default): relay used, whether Media Encoder answers, its build. log: the last host errors and the ' +
      'boot log tail. There is no reloadHost: the Media Encoder script is sent fresh on every call.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', enum: ['health', 'log'] }, limit: { type: 'number' } } },
  },
];

/* ---------- helpers ---------- */

const textContent = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const errorContent = (m) => ({ content: [{ type: 'text', text: m }], isError: true });

function minFreeBytes() {
  const gb = Number(process.env.AME_MCP_MIN_FREE_GB || 15);
  return (Number.isFinite(gb) && gb >= 0 ? gb : 15) * 1024 ** 3;
}

/*
 * shortcut: scans the whole project, not just this comp; per-comp needs RIFX parsing.
 * Expression text sits as plain ASCII in the .aep. A project that is huge or UTF-16 encoded is not handled.
 */
function expressionLibraries(aepPath) {
  const text = fs.readFileSync(aepPath).toString('latin1');
  const files = new Set();
  for (const m of text.matchAll(/footage\(\s*(["'])([^"']+?)\1\s*\)\s*\.sourceData/g)) files.add(m[2]);
  return { files: [...files], evalFile: /\$\.evalFile/.test(text) };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/* Media Encoder may change the extension (some presets write .mov), so match the path or the same name with any extension. */
function findOutput(want) {
  const stat = (p) => { try { const s = fs.statSync(p); return s.isFile() ? { path: p, size: s.size, mtimeMs: s.mtimeMs } : null; } catch (e) { return null; } };
  const exact = stat(want);
  if (exact) return exact;
  const { dir, name } = nodePath.parse(want);
  let found = null;
  let kids = [];
  try { kids = fs.readdirSync(dir); } catch (e) { return null; }
  for (const k of kids) {
    if (nodePath.parse(k).name !== name) continue;
    const s = stat(nodePath.join(dir, k));
    if (s && (!found || s.mtimeMs > found.mtimeMs)) found = s;
  }
  return found;
}

/**
 * @param {(op:string,args:object,timeoutMs?:number)=>Promise<object>} callHost
 * @param {{freeBytes?: Function, presetRoots?: string[], bootLog?: string, sleep?: (ms:number)=>Promise<void>}} [deps] test seams
 */
function createToolRegistry(callHost, deps = {}) {
  const free = deps.freeBytes || freeBytes;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const errors = [];
  const jobs = new Map();
  let seq = 0;

  async function host(op, args, timeoutMs) {
    const res = await callHost(op, args, timeoutMs);
    if (!res.ok) {
      const e = res.error || {};
      errors.push({ at: new Date().toISOString(), op, code: e.code || 'error', message: e.message || 'unknown host failure' });
      if (errors.length > 20) errors.shift();
      throw new Error(`${e.code || 'error'}: ${e.message || 'unknown host failure'}`);
    }
    return res.result;
  }

  const relay = () => (typeof callHost.lastRelay === 'function' ? callHost.lastRelay() : null);

  function mustExist(p, what) {
    if (typeof p !== 'string' || !nodePath.isAbsolute(p)) throw new Error(`bad_value: ${what} must be an absolute path`);
    if (!fs.existsSync(p)) throw new Error(`missing_file: no ${what} at ${p}`);
  }

  async function queue(a) {
    if (a.command !== 'comp' && a.command !== 'file') return errorContent(`Unknown ame_queue command ${a.command}. Known: comp, file`);
    const out = checkWritePath(a.path, 'path', PROTECTED_ENV);
    if (!nodePath.extname(out)) throw new Error('bad_value: path must end in the extension the preset writes, e.g. .mp4 or .mov');
    if (!a.overwrite && fs.existsSync(out)) throw new Error(`exists: ${out} exists; pass overwrite:true to replace it`);
    if (typeof a.preset !== 'string' || !fs.existsSync(a.preset)) {
      throw new Error(`missing_file: no export preset at ${a.preset}; list them with ame_query presets`);
    }
    const source = a.command === 'comp' ? a.projectPath : a.source;
    mustExist(source, a.command === 'comp' ? 'project' : 'source');
    if (a.command === 'comp' && (typeof a.guid !== 'string' || !a.guid)) {
      throw new Error('bad_value: guid is required; Media Encoder cannot look a comp up by name. List guids with ame_query compItems');
    }
    const have = free(out);
    if (have < minFreeBytes()) {
      throw new Error(`low_disk: ${(have / 1024 ** 3).toFixed(1)} GiB free on the disk for ${out}, under the ` +
        `${(minFreeBytes() / 1024 ** 3).toFixed(0)} GiB floor (AME_MCP_MIN_FREE_GB). Nothing was queued.`);
    }
    if (a.command === 'comp' && !a.allowExpressionLibrary) {
      const lib = expressionLibraries(source);
      if (lib.files.length || lib.evalFile) {
        const what = [...lib.files.map((f) => `"${f}"`), ...(lib.evalFile ? ['$.evalFile'] : [])].join(', ');
        throw new Error(`expression_library: ${source} reads a data or script file through footage(...).sourceData ` +
          `(or calls $.evalFile): ${what}. Media Encoder and aerender use After Effects' headless engine, which returns ` +
          'nothing for those files, silently, so the comp would render frozen. Render it in After Effects\' Render ' +
          'Queue (ae_render) instead, or pass allowExpressionLibrary:true to queue it anyway.');
      }
    }
    const queued = a.command === 'comp'
      ? await host('queueComp', { projectPath: source, guid: a.guid, format: a.format || '', presetPath: a.preset, outputPath: out }, 60000)
      : await host('queueFile', { filePath: source, format: a.format || '', presetPath: a.preset, outputPath: out }, 60000);
    const jobId = `ame-${++seq}-${crypto.randomBytes(3).toString('hex')}`;
    jobs.set(jobId, { jobId, kind: a.command, source, comp: a.comp || null, guid: a.guid || null, preset: a.preset,
      output: out, queuedAt: new Date().toISOString(), completedBefore: queued.completedBefore, cleared: false });
    let started = false;
    if (a.start !== false) started = !!(await host('start', {})).started;
    return textContent({ jobId, output: out, started, relay: relay(), freeGiBBefore: Number((have / 1024 ** 3).toFixed(1)) });
  }

  function jobView(j, ame) {
    const f = findOutput(j.output);
    let state = 'queued';
    if (f && f.size > 0) state = ame.isBatchRunning ? 'encoding' : 'done';
    else if (j.cleared) state = 'cleared';
    else if (!ame.isBatchRunning && ame.errors > 0) state = 'failed';
    return { jobId: j.jobId, kind: j.kind, source: j.source, comp: j.comp, preset: j.preset, output: j.output,
      queuedAt: j.queuedAt, state, outputFile: f ? { path: f.path, size: f.size } : null };
  }

  async function status(a) {
    const ame = await host('status', {});
    let list = [...jobs.values()];
    if (a.jobId) list = list.filter((j) => j.jobId === a.jobId);
    if (a.jobId && !list.length) throw new Error(`unknown_job: no job ${a.jobId}`);
    if (a.command === 'finished') {
      const before = new Map(list.map((j) => [j.jobId, findOutput(j.output)]));
      await sleep(1000);
      const done = [];
      for (const j of list) {
        const b = before.get(j.jobId), f = findOutput(j.output);
        if (!b || !f || f.size === 0 || b.size !== f.size || f.path !== b.path) continue;
        if (ame.isBatchRunning && !(ame.completed > j.completedBefore)) continue;
        done.push({ jobId: j.jobId, path: f.path, size: f.size, sha256: await sha256(f.path) });
      }
      return textContent({ finished: done, batchStatus: ame.batchStatus });
    }
    return textContent({ ame, relay: relay(), jobs: list.map((j) => jobView(j, ame)) });
  }

  function bootLog(n) {
    const file = deps.bootLog || nodePath.join(os.tmpdir(), 'ame-mcp-vision', 'boot.log');
    try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n); } catch (e) { return []; }
  }

  const handlers = {
    ame_query: async (a) => {
      switch (a.command) {
        case 'sessionInfo': return textContent({ ...(await host('info', {})), relay: relay(), bridge: bridgeInfo() });
        case 'formats': return textContent({ formats: (await host('info', {})).formats });
        case 'presets': return textContent(listPresets(a.match, a.limit || 50, deps.presetRoots));
        case 'compItems':
          mustExist(a.projectPath, 'project');
          return textContent(await host('compItems', { projectPath: a.projectPath }, 60000));
        case 'describe': {
          if (!a.tool) return textContent({ tools: TOOLS.map((t) => t.name), bridge: bridgeInfo() });
          const def = TOOLS.find((t) => t.name === a.tool);
          if (!def) return errorContent(`No tool named ${a.tool}. Known: ${TOOLS.map((t) => t.name).join(', ')}`);
          return textContent({ ...def, bridge: bridgeInfo() });
        }
        default: return errorContent(`Unknown ame_query command ${a.command}`);
      }
    },
    ame_queue: queue,
    ame_batch: async (a) => {
      if (!['start', 'pause', 'stop', 'clear'].includes(a.command)) return errorContent(`Unknown ame_batch command ${a.command}`);
      if (a.command === 'clear' && a.all !== true) {
        throw new Error('needs_all: clear empties Media Encoder\'s whole queue, other people\'s items included; pass all:true');
      }
      const res = await host(a.command, {});
      if (a.command === 'clear') jobs.forEach((j) => { j.cleared = true; });
      return textContent(res);
    },
    ame_status: (a) => {
      const cmd = a.command || 'status';
      if (cmd !== 'status' && cmd !== 'finished') return Promise.resolve(errorContent(`Unknown ame_status command ${cmd}`));
      return status({ ...a, command: cmd });
    },
    ame_diagnostics: async (a) => {
      const cmd = a.command || 'health';
      if (cmd === 'log') return textContent({ hostErrors: errors.slice(-(a.limit || 20)), bootLog: bootLog(a.limit || 20) });
      if (cmd !== 'health') return errorContent(`Unknown ame_diagnostics command ${cmd}`);
      const out = { bridge: bridgeInfo(), ameReachable: false };
      try {
        const info = await host('info', {});
        out.ameReachable = true;
        out.buildNumber = info.buildNumber;
        out.batchStatus = info.batchStatus;
      } catch (err) { out.error = String(err.message || err); }
      out.relay = relay();
      out.recentHostErrors = errors.length;
      return textContent(out);
    },
  };

  return {
    tools: TOOLS,
    async callTool(name, args) {
      const handler = handlers[name];
      if (!handler) return errorContent(`Unknown tool: ${name}`);
      try { return await handler(args || {}); } catch (err) { return errorContent(String((err && err.message) || err)); }
    },
  };
}

module.exports = { createToolRegistry, TOOLS, expressionLibraries, findOutput };
