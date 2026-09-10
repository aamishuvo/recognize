#!/usr/bin/env node
/**
 * Builds every distributable form of the engine from the single source of
 * truth: src/recognize-auto-liker.js
 *
 *   node tools/build.cjs
 *
 * Outputs:
 *   userscript/recognize-auto-liker.user.js   Tampermonkey userscript
 *   extension/core.js                         Unpacked-extension content script
 *   dist/console-snippet.js                   Paste-into-DevTools version
 *   dist/bookmarklet.txt                      One-line javascript: bookmarklet
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(ROOT, 'src', 'recognize-auto-liker.js'), 'utf8');
const version = (core.match(/var VERSION = '([^']+)'/) || [, '0.0.0'])[1];

const BANNER = [
  '/* GENERATED FILE — do not edit.',
  '   Source: src/recognize-auto-liker.js   Build: node tools/build.cjs */',
  ''
].join('\n');

function write(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  console.log('  wrote ' + rel + '  (' + Math.round(content.length / 1024) + ' KB)');
}

/* ------------------------------------------------------- 1. userscript */
const userscript = [
  '// ==UserScript==',
  '// @name         Recognize Auto Liker',
  '// @namespace    local.recognize.autoliker',
  '// @version      ' + version,
  '// @description  Likes RecognizeApp recognition posts you have not liked yet. No login/credential handling.',
  '// @author       local',
  '// @match        https://*.recognizeapp.com/*',
  '// @match        https://recognizeapp.com/*',
  '// @run-at       document-idle',
  '// @grant        none',
  '// @noframes',
  '// ==/UserScript==',
  '',
  BANNER,
  core
].join('\n');
write('userscript/recognize-auto-liker.user.js', userscript);

/* ------------------------------------------- 2. unpacked extension core */
write('extension/core.js', BANNER + core);

/* --------------------------------------------------- 3. console snippet */
write('dist/console-snippet.js', BANNER + core);

/* ------------------------------------------------------- 4. bookmarklet */
const bookmarklet = 'javascript:' + encodeURIComponent(
  '(function(){try{' + core + '}catch(e){alert("Recognize Auto Liker failed to load: "+e.message);}})();'
);
write('dist/bookmarklet.txt', bookmarklet + '\n');

console.log('\nBuilt v' + version + '.\n');
