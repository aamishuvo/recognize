#!/usr/bin/env node
/**
 * Builds the standalone (non-extension) delivery forms.
 *
 * THE EXTENSION NEEDS NONE OF THIS. `extension/` is loadable as-is with no
 * build step, no Node and no npm. This script only produces the fallback
 * forms for machines where unpacked extensions are blocked by policy.
 *
 *   node tools/build.cjs
 *
 * Both outputs are the SAME engine the extension runs
 * (extension/content/engine.js) plus a floating-panel host, so there is
 * exactly one implementation of the click-safety gate in this repository.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const engine = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'engine.js'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'src', 'standalone-panel.js'), 'utf8');
const version = (engine.match(/var VERSION = '([^']+)'/) || [, '0.0.0'])[1];

const BANNER = [
  '/* GENERATED FILE — do not edit.',
  '   Sources: extension/content/engine.js + src/standalone-panel.js',
  '   Rebuild: node tools/build.cjs */',
  ''
].join('\n');

const combined = BANNER + engine + '\n' + panel;

function write(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  console.log('  wrote ' + rel + '  (' + Math.round(content.length / 1024) + ' KB)');
}

write('userscript/recognize-auto-liker.user.js', [
  '// ==UserScript==',
  '// @name         Recognize Auto Liker',
  '// @namespace    local.recognize.autoliker',
  '// @version      ' + version,
  '// @description  Likes RecognizeApp recognitions you have not liked yet. Never removes an existing like.',
  '// @author       local',
  '// @match        https://*.recognizeapp.com/*',
  '// @match        https://recognizeapp.com/*',
  '// @run-at       document-idle',
  '// @grant        none',
  '// @noframes',
  '// ==/UserScript==',
  '',
  combined
].join('\n'));

write('dist/console-snippet.js', combined);

write('dist/bookmarklet.txt', 'javascript:' + encodeURIComponent(
  '(function(){try{' + engine + '\n' + panel + '}catch(e){alert("Recognize Auto Liker failed to load: "+e.message);}})();'
) + '\n');

console.log('\nBuilt standalone fallbacks v' + version + '. The extension is unaffected.\n');
