/**
 * Hard redaction for everything written to the community store.
 *
 * This module is the only place that decides what leaves the machine, so both
 * the agent tools and the panel's HTTP routes share one rule set. It is applied
 * on the write path: there is no flag that turns it off.
 */

const REDACTIONS = [
  { kind: 'key', pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, label: '[密钥]' },
  { kind: 'key', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, label: '[密钥]' },
  { kind: 'key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: '[密钥]' },
  { kind: 'key', pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/g, label: 'Bearer [密钥]' },
  {
    kind: 'link',
    pattern: /(?=https?:\/\/[^\s"'，。；）)]*[?&][^\s"'，。；）)]*=)https?:\/\/[^\s"'，。；）)]+/g,
    label: '[带参数链接]',
  },
  {
    kind: 'path',
    pattern: /(?:[A-Za-z]:\\[^\s"'，。；：、）)]+|\/(?:root|home|etc|var|opt|tmp|mnt|srv|data|usr|proc)\/[^\s"'，。；：、）)]*|~\/[^\s"'，。；：、）)]*)/g,
    label: '[路径]',
  },
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: '[邮箱]' },
  { kind: 'ip', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, label: '[IP]' },
  { kind: 'token', pattern: /\b[0-9a-fA-F]{32,}\b/g, label: '[长串]' },
];

export function redact(value) {
  let text = String(value == null ? '' : value);
  const counts = {};
  for (const rule of REDACTIONS) {
    text = text.replace(rule.pattern, () => {
      counts[rule.kind] = (counts[rule.kind] || 0) + 1;
      return rule.label;
    });
  }
  return { text, counts };
}

/** Redact first, cut second: truncating a secret first could leave half of it intact. */
export function field(value, max) {
  const result = redact(String(value == null ? '' : value).trim());
  return { text: result.text.slice(0, max), counts: result.counts };
}

export function countOf(counts) {
  return Object.keys(counts).reduce((total, key) => total + counts[key], 0);
}
