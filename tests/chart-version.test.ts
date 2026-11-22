import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncChartVersion } from '../scripts/sync-chart-version.mjs';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Helm chart version', () => {
  it('updates chart and app versions from package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-chart-version-'));
    dirs.push(dir);
    const packagePath = join(dir, 'package.json');
    const chartPath = join(dir, 'Chart.yaml');
    writeFileSync(packagePath, '{"version":"1.2.3"}\n');
    writeFileSync(chartPath, 'apiVersion: v2\nname: rproxy-ui\nversion: 1.0.0\nappVersion: "1.0.0"\n');

    expect(syncChartVersion(packagePath, chartPath)).toBe('1.2.3');
    expect(readFileSync(chartPath, 'utf8')).toBe('apiVersion: v2\nname: rproxy-ui\nversion: 1.2.3\nappVersion: "1.2.3"\n');
  });

  it('refuses a chart missing one of its version fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-chart-version-'));
    dirs.push(dir);
    const packagePath = join(dir, 'package.json');
    const chartPath = join(dir, 'Chart.yaml');
    writeFileSync(packagePath, '{"version":"1.2.3"}\n');
    writeFileSync(chartPath, 'apiVersion: v2\nname: rproxy-ui\nversion: 1.0.0\n');

    expect(() => syncChartVersion(packagePath, chartPath)).toThrow('expected exactly one appVersion');
  });
});
