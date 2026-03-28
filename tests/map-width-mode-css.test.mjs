import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainCss = readFileSync(resolve(__dirname, '../src/styles/main.css'), 'utf-8');
const panelsCss = readFileSync(resolve(__dirname, '../src/styles/panels.css'), 'utf-8');

describe('map width mode CSS', () => {
  it('defines all ultra-wide width-mode classes', () => {
    assert.match(mainCss, /\.main-content\.map-width-default\s*\{/);
    assert.match(mainCss, /\.main-content\.map-width-extend-1\s*\{/);
    assert.match(mainCss, /\.main-content\.map-width-extend-2\s*\{/);
    assert.match(mainCss, /\.main-content\.map-width-hide\s*\{/);
  });

  it('puts the panels grid below the map in extend-2 mode', () => {
    assert.match(
      mainCss,
      /\.main-content\.map-width-extend-2 \.panels-grid\s*\{[\s\S]*grid-column:\s*1;[\s\S]*grid-row:\s*2;/,
    );
  });

  it('reduces the sidebar to a single panel column in extend-1 mode', () => {
    assert.match(
      mainCss,
      /\.main-content\.map-width-extend-1 \.panels-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(280px, 1fr\);/,
    );
  });

  it('shows the map width toggle only in the ultra-wide rules', () => {
    assert.match(mainCss, /\.map-width-toggle\s*\{[\s\S]*display:\s*none;/);
    assert.match(mainCss, /@media \(min-width: 1600px\) \{[\s\S]*\.map-width-toggle\s*\{[\s\S]*display:\s*flex;/);
  });

  it('keeps a restore strip visible when panels-only mode is active', () => {
    assert.match(
      mainCss,
      /\.main-content\.map-width-hide \.map-width-restore\s*\{[\s\S]*display:\s*flex;[\s\S]*grid-column:\s*1;[\s\S]*grid-row:\s*1;/,
    );
    assert.match(
      mainCss,
      /\.main-content\.map-width-hide \.map-section\s*\{[\s\S]*display:\s*none;/,
    );
  });

  it('pins a non-collapsing top row for extend-2 map mode', () => {
    assert.match(
      mainCss,
      /\.main-content\.map-width-extend-2\s*\{[\s\S]*grid-template-rows:\s*minmax\(420px, 58vh\) minmax\(0, 1fr\);/,
    );
  });

  it('widens the map-bottom grid for full-width map mode', () => {
    assert.match(
      panelsCss,
      /\.main-content\.map-width-extend-2 \.map-bottom-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(4, 1fr\);/,
    );
  });
});
