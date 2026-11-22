import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function replaceOnce(source, pattern, replacement, field) {
  const matches = source.match(new RegExp(pattern, 'gm'));
  if (matches?.length !== 1) {
    throw new Error(`expected exactly one ${field} in Chart.yaml`);
  }
  return source.replace(pattern, replacement);
}

export function syncChartVersion(
  packagePath = fileURLToPath(new URL('../package.json', import.meta.url)),
  chartPath = fileURLToPath(new URL('../charts/rproxy-ui/Chart.yaml', import.meta.url)),
) {
  const { version } = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json has no valid version');
  }

  let chart = readFileSync(chartPath, 'utf8');
  chart = replaceOnce(chart, /^version: [^\r\n]+$/m, `version: ${version}`, 'version');
  chart = replaceOnce(chart, /^appVersion: [^\r\n]+$/m, `appVersion: "${version}"`, 'appVersion');
  writeFileSync(chartPath, chart);
  return version;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncChartVersion(...process.argv.slice(2));
}
