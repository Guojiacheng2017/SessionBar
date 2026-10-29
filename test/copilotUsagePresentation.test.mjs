import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import test from 'node:test';

const source = readFileSync(new URL('../src/providers/providerUsageMetrics.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { providerUsageTrendForMode } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('Copilot retains monthly cumulative line in every metric mode', () => {
  const monthly = { kind: 'line', days: 30, points: [null, 10, 20], unit: 'AI credits' };
  const daily = { kind: 'bars', days: 7, points: [1, 2], unit: '%' };
  const row = { provider: 'github', label: 'GitHub Copilot Pro', usageTrend: monthly,
    usageTrends: { percentage: daily, token: daily, cash: daily } };
  for (const mode of ['token', 'cash', 'percentage']) {
    assert.equal(providerUsageTrendForMode(row, mode), monthly);
  }
  assert.equal(providerUsageTrendForMode({ ...row, provider: 'openai', label: 'OpenAI' }, 'percentage'), daily);
});
