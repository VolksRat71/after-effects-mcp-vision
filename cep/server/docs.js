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

const DOCS_DIR = path.join(__dirname, '..', '..', 'docs');

const RESOURCES = [
  {
    uri: 'ae-vision://capabilities',
    name: 'Capability matrix',
    description:
      'Every probed After Effects technique with a pass / fail / needs-human-review verdict, ' +
      'measured against a live AE build rather than read off the API docs. Read this before ' +
      'telling a user something is impossible - and before assuming something is possible.',
    mimeType: 'text/markdown',
    file: path.join(DOCS_DIR, 'CAPABILITIES.md'),
  },
  {
    uri: 'ae-vision://recipes',
    name: 'Authoring recipes and gotchas',
    description:
      'How to actually build something: the create-then-style chain, the accepted value shapes ' +
      'for ae_set, and the measurement traps that silently produce wrong layouts.',
    mimeType: 'text/markdown',
    file: path.join(DOCS_DIR, 'RECIPES.md'),
  },
  {
    uri: 'ae-vision://install',
    name: 'Install and troubleshooting',
    description: 'Installation, the signing/Gatekeeper situation, and what to do when the panel will not connect.',
    mimeType: 'text/markdown',
    file: path.join(DOCS_DIR, 'INSTALL.md'),
  },
];

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
    text = fs.readFileSync(entry.file, 'utf8');
  } catch (err) {
    // A missing doc is a packaging bug. Say so rather than returning nothing,
    // so it surfaces as a real problem instead of an empty page.
    text = `Documentation file is missing from this install: ${entry.file}\n\n${String(err.message || err)}`;
  }
  return { contents: [{ uri: entry.uri, mimeType: entry.mimeType, text }] };
}

module.exports = { listResources, readResource, RESOURCES };
