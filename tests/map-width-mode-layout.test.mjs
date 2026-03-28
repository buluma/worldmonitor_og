import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelLayoutSrc = readFileSync(resolve(__dirname, '../src/app/panel-layout.ts'), 'utf-8');
const variantBaseSrc = readFileSync(resolve(__dirname, '../src/config/variants/base.ts'), 'utf-8');

describe('map width mode layout', () => {
  it('defines the persisted map width mode union and storage key', () => {
    assert.match(panelLayoutSrc, /type MapWidthMode = 'default' \| 'extend-1' \| 'extend-2' \| 'hide';/);
    assert.match(panelLayoutSrc, /STORAGE_KEYS\.mapWidthMode/);
    assert.match(variantBaseSrc, /mapWidthMode: 'worldmonitor-map-width-mode'/);
  });

  it('forces only the AI column into the bottom grid for extend-1', () => {
    assert.match(
      panelLayoutSrc,
      /'extend-1': \['insights', 'strategic-posture'\]/,
      'extend-1 should only force the AI column below the map',
    );
  });

  it('forces both right-side anchor columns into the bottom grid for extend-2', () => {
    assert.match(
      panelLayoutSrc,
      /'extend-2': \['insights', 'strategic-posture', 'cii', 'strategic-risk'\]/,
      'extend-2 should force both top-right columns below the map',
    );
  });

  it('keeps hide mode out of the forced-bottom routing set', () => {
    assert.match(
      panelLayoutSrc,
      /hide: \[\]/,
      'hide mode should move panels into the main grid rather than forcing map-bottom placement',
    );
  });

  it('computes an effective bottom set by merging saved and mode-forced panels', () => {
    assert.match(panelLayoutSrc, /private getEffectiveBottomSet\(mode: MapWidthMode = this\.getEffectiveMapWidthMode\(\)\): Set<string> \{/);
    assert.match(panelLayoutSrc, /const effective = new Set\(this\.bottomSetMemory\);/);
    assert.match(panelLayoutSrc, /this\.getModeForcedBottomSet\(mode\)\.forEach\(\(id\) => effective\.add\(id\)\);/);
  });

  it('re-homes zones when width mode changes without mutating saved bottom membership', () => {
    const setModeBlock = panelLayoutSrc.match(/private setMapWidthMode\(mode: MapWidthMode\): void \{([\s\S]*?)\n\s*\}/);
    assert.ok(setModeBlock, 'expected setMapWidthMode() block');
    assert.match(setModeBlock[1], /localStorage\.setItem\(STORAGE_KEYS\.mapWidthMode, mode\);/);
    assert.match(setModeBlock[1], /this\.applyMapWidthMode\(\);/);
    assert.match(setModeBlock[1], /this\.ensureCorrectZones\(true\);/);
    assert.match(setModeBlock[1], /this\.syncMapAfterWidthModeChange\(\);/);

    assert.match(
      panelLayoutSrc,
      /if \(isInBottom && !this\.isModeForcedBottomPanel\(key\)\) \{\s*this\.bottomSetMemory\.add\(key\);\s*\} else \{\s*this\.bottomSetMemory\.delete\(key\);\s*\}/s,
      'forced-bottom panels must not be persisted into bottomSetMemory',
    );
  });

  it('syncs the map after width-mode layout changes', () => {
    assert.match(panelLayoutSrc, /private syncMapAfterWidthModeChange\(delayMs = 320\): void \{/);
    assert.match(panelLayoutSrc, /this\.ctx\.map\?\.resize\(\)/);
    assert.match(panelLayoutSrc, /requestAnimationFrame\(sync\)/);
    assert.match(panelLayoutSrc, /window\.setTimeout\(sync, delayMs\)/);
  });

  it('renders a shared toggle with an explicit OFF state for panels-only mode', () => {
    assert.match(panelLayoutSrc, /private renderMapWidthToggle\(location: 'header' \| 'restore'\): string \{/);
    assert.match(panelLayoutSrc, /data-map-width-mode="hide"/);
    assert.match(panelLayoutSrc, />OFF</);
    assert.match(panelLayoutSrc, /id="mapWidthRestore"/);
  });
});
