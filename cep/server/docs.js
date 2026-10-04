/*
 * Documentation exposed over MCP as resources.
 *
 * The schemas tell an agent what arguments exist; they cannot tell it that
 * sourceRectAtTime ignores Scale, or that a shape gradient is unreachable. That
 * knowledge used to live only in repo markdown and source comments, which an
 * agent driving this server over HTTP can never see - so it was rediscovered by
 * failing. These resources put it on the wire.
 */

const fs = require('fs');
const path = require('path');

/*
 * Where the docs live depends on how the extension was installed. The
 * packagers copy docs/ INTO the extension, so a release has <ext>/docs. A dev
 * install symlinks cep/ itself, so there the docs sit one level further up, in
 * the repo root. Only the second path used to be checked, which meant every
 * packaged install answered every resource with "file is missing".
 */
const DOCS_CANDIDATES = [
  path.join(__dirname, '..', 'docs'),        // packaged: <ext>/docs
  path.join(__dirname, '..', '..', 'docs'),  // dev checkout: <repo>/docs
];

function resolveDoc(name) {
  for (const dir of DOCS_CANDIDATES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Report the packaged location, since that is where a release should have it.
  return path.join(DOCS_CANDIDATES[0], name);
}

// Each app serves its own docs; see app-profile.js.
const RESOURCES = require('./app-profile.js').currentProfile().resources;

/** Resource descriptors for resources/list - no file contents. */
function listResources() {
  return RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
}

/**
 * Read one resource by uri.
 * @returns {{contents: Array}|null} null when the uri is unknown.
 */
function readResource(uri) {
  const entry = RESOURCES.find((r) => r.uri === uri);
  if (!entry) return null;

  let text;
  try {
    text = fs.readFileSync(resolveDoc(entry.file), 'utf8');
  } catch (err) {
    // A missing doc is a packaging bug. Say so rather than returning nothing,
    // so it surfaces as a real problem instead of an empty page.
    text = `Documentation file is missing from this install: ${resolveDoc(entry.file)}\n\n${String(err.message || err)}`;
  }
  return { contents: [{ uri: entry.uri, mimeType: entry.mimeType, text }] };
}

module.exports = { listResources, readResource, resolveDoc, RESOURCES, DOCS_CANDIDATES };
