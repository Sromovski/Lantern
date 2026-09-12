import type { CheckResult } from './checks.js';

const LABEL = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' } as const;

export function formatReport(results: CheckResult[]): string {
  const lines = results.map((r) => `${LABEL[r.status]} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  lines.push('', `${failed} failed, ${warned} warning${warned === 1 ? '' : 's'}`);
  return lines.join('\n');
}

export function exitCode(results: CheckResult[]): 0 | 1 {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
