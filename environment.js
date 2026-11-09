import { parse } from 'smol-toml';

export const ENVIRONMENT_FILE = '.codex/environments/environment.toml';
const MAX_CONFIG = 128 * 1024;

/** Parse the verified Codex local-environment v1 subset; never guess executable fields. */
export function parseEnvironment(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CONFIG) throw new Error('Codex environment config exceeds 128 KiB.');
  const value = parse(text);
  if (value.version !== 1) throw new Error('Unsupported Codex environment version; expected version = 1.');
  for (const key of Object.keys(value)) {
    if (!['version', 'name', 'setup', 'actions'].includes(key)) throw new Error(`Unsupported Codex environment field: ${key}; refusing to guess execution semantics.`);
  }
  if (value.setup === undefined) return null;
  if (!value.setup || typeof value.setup !== 'object' || Array.isArray(value.setup)) throw new Error('Invalid Codex [setup] table.');
  for (const key of Object.keys(value.setup)) {
    if (key !== 'script') throw new Error(`Unsupported Codex setup field: ${key}; refusing to guess platform-specific execution.`);
  }
  if (value.setup.script === undefined) return null;
  if (typeof value.setup.script !== 'string' || value.setup.script.includes('\0')) throw new Error('Codex setup.script must be a string without NUL.');
  return value.setup.script.trim() ? { script: value.setup.script, file: ENVIRONMENT_FILE } : null;
}

/** Use the mounted FS: only a file present in the newly checked-out tree can execute. */
export function createEnvironmentInitializer(provider) {
  return async function initialize(agent, checkout, signal, onProgress) {
    const deadline = AbortSignal.timeout(10 * 60 * 1000);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    signal.throwIfAborted();
    const fs = provider(agent, 'fs');
    const info = await fs.lstat(ENVIRONMENT_FILE, { cwd: checkout.path }, signal);
    if (!info) return { status: 'skipped', reason: 'No Codex local environment config in the new checkout.' };
    if (info.type !== 'file' || (info.size ?? MAX_CONFIG + 1) > MAX_CONFIG) throw new Error('Codex environment must be a regular file of at most 128 KiB.');
    const root = await fs.resolve(checkout.path, { signal });
    const target = await fs.resolve(ENVIRONMENT_FILE, { cwd: checkout.path, signal });
    if (!fs.contains(root, target)) throw new Error('Codex environment config must stay inside the new checkout.');
    const bytes = await fs.readBytes(target, signal, MAX_CONFIG);
    const config = parseEnvironment(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!config) return { status: 'skipped', reason: 'No setup script configured.' };
    const current = await fs.lstat(ENVIRONMENT_FILE, { cwd: checkout.path }, signal);
    if (current?.version !== info.version) throw new Error('Codex environment changed while loading; initialization was not started.');
    const subprocess = provider(agent, 'subprocess');
    const environment = await subprocess.terminalEnvironment(signal);
    if (environment.platform !== 'posix') throw new Error('Codex setup execution on Windows is not yet verified; no script was executed.');
    const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
    // Selecting New worktree is not permission to bypass a restricted Session.
    // The ordinary mounted sandbox remains the authority for this script.
    const shell = await subprocess.resolveExecutable(environment.defaultShell || 'sh', undefined, signal);
    let argv = [shell, '-lc', config.script];
    if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
    if (provider(agent, 'workingDirectory').get(agent.session) !== checkout.path) throw new Error('Session directory changed before setup.');
    signal?.throwIfAborted();
    await onProgress?.({ phase: 'initializing', command: config.script.slice(0, 4096), cwd: checkout.path });
    const child = subprocess.spawn({ argv, cwd: checkout.path, signal, graceMs: 3000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 128 * 1024 } } });
    // Sample only the running child's non-consuming collectors, never Git or
    // session state. Await each publish; a storage failure stops preparation.
    let stopped = false, timer, wake, sampling;
    const offsets = { stdout: 0, stderr: 0 };
    async function sample() {
      if (!onProgress) return;
      for (const key of ['stdout', 'stderr']) {
        const part = child.collected[key].readFrom(offsets[key]);
        if (Number.isSafeInteger(part.nextOffset)) {
          if (part.nextOffset <= offsets[key]) continue;
          offsets[key] = part.nextOffset;
        } else {
          // Some minimal adapters expose only a full snapshot.
          if (offsets[key]) continue;
          offsets[key] = Math.max(1, Buffer.byteLength(part.text));
        }
        if (part.text) await onProgress({ text: part.text });
      }
    }
    if (onProgress) sampling = (async () => {
      while (!stopped) {
        await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 200); });
        clearTimeout(timer); wake = undefined;
        if (!stopped) await sample();
      }
    })();
    try {
      const outcome = await (sampling ? Promise.race([child.done, sampling.then(() => { throw new Error('Setup output sampler ended unexpectedly.'); })]) : child.done);
      stopped = true; clearTimeout(timer); wake?.(); await sampling;
      await sample();
      signal?.throwIfAborted();
      const stdout = child.collected.stdout.readFrom(0), stderr = child.collected.stderr.readFrom(0);
      if (outcome.exitCode !== 0) throw new Error(`Codex setup failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.slice(-4000) || stdout.text.slice(-4000)}`);
      return { status: 'succeeded', reason: '', file: ENVIRONMENT_FILE };
    } finally {
      stopped = true; clearTimeout(timer); wake?.();
      child.terminate(); await child.waitForExit();
      // The primary try already observes sampler rejection; teardown must join it.
      await sampling?.catch(() => {});
    }
  };
}
