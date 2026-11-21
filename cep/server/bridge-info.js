/*
 * Which bridge is actually running. A client can hold a stale tool list after
 * an update - it happened after the 2.0.4 reinstall: the session still showed
 * the old ae_masks schema while the server ran 2.0.4 - so health and
 * sessionInfo report the version, and in dev mode the branch and commit too.
 *
 * mode is "dev" when the extension runs from a checkout: .debug exists only in
 * the repo and is excluded from every package.
 */

const fs = require('fs');
const path = require('path');

const CEP = path.join(__dirname, '..');

function readVersion() {
  try {
    const xml = fs.readFileSync(path.join(CEP, 'CSXS', 'manifest.xml'), 'utf8');
    const m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

/*
 * In a git worktree .git is a file ("gitdir: <path>") naming the worktree's own
 * git dir, which keeps HEAD but shares refs with the main repository through
 * its commondir. Reading .git as a folder there reported commit: null.
 */
function gitDirs(repo) {
  const dotGit = path.join(repo, '.git');
  if (fs.statSync(dotGit).isDirectory()) return { git: dotGit, common: dotGit };
  const git = path.resolve(repo, fs.readFileSync(dotGit, 'utf8').trim().replace(/^gitdir: /, ''));
  let common = git;
  try { common = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim()); } catch (e) {}
  return { git, common };
}

function readGit(repo) {
  try {
    const { git, common } = gitDirs(repo);
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return { branch: null, commit: head.slice(0, 7) };
    const ref = head.slice(5);
    let sha = null;
    try { sha = fs.readFileSync(path.join(common, ref), 'utf8').trim(); } catch (e) {
      const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
      sha = line ? line.split(' ')[0] : null;
    }
    return { branch: ref.replace(/^refs\/heads\//, ''), commit: sha ? sha.slice(0, 7) : null };
  } catch (e) { return { branch: null, commit: null }; }
}

function bridgeInfo() {
  const dev = fs.existsSync(path.join(CEP, '.debug'));
  const info = { version: readVersion(), mode: dev ? 'dev' : 'release' };
  if (dev) Object.assign(info, readGit(path.join(CEP, '..')));
  return info;
}

module.exports = { bridgeInfo };
