export interface SecretFinding {
  file: string;
  line: number;
  column: number;
  ruleId: string;
  description: string;
  redactedLine: string;
}

interface SecretRule {
  id: string;
  description: string;
  regex: RegExp;
  secretGroup?: number;
  entropyRequired?: boolean;
}

const secretRules: SecretRule[] = [
  {
    id: 'private-key',
    description: 'Private key block marker',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key id',
    regex: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'github-token',
    description: 'GitHub access token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
  },
  {
    id: 'openai-key',
    description: 'OpenAI API key',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    regex: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret key',
    regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'generic-secret-assignment',
    description: 'High-entropy secret assignment',
    regex:
      /\b(?:api[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|token)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{20,})["']?/gi,
    secretGroup: 1,
    entropyRequired: true,
  },
];

const placeholderPatterns = [
  /^\$\{[A-Z0-9_]+\}$/,
  /^<[^>]+>$/,
  /^(?:your|example|sample|test|dummy|fake|placeholder|changeme|replace-me)[-_]/i,
  /^(?:secret-123|my-secret|supersecret|admin-secret|agent-secret|global-admin-secret|codex-secret|token123)$/i,
];

export function scanSecrets(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';

    for (const rule of secretRules) {
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = rule.regex.exec(line)) !== null) {
        const secret = match[rule.secretGroup ?? 0];
        if (!secret) continue;

        const secretStart = match.index + match[0].indexOf(secret);
        if (
          isAllowedPlaceholder(secret) ||
          (rule.id === 'generic-secret-assignment' && isLikelyCodeReference(secret)) ||
          (rule.entropyRequired && !looksHighEntropy(secret))
        ) {
          continue;
        }

        const key = `${lineIndex}:${secretStart}:${secret}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push({
          file,
          line: lineIndex + 1,
          column: secretStart + 1,
          ruleId: rule.id,
          description: rule.description,
          redactedLine: redactLine(line, secretStart, secret.length),
        });
      }
    }
  }

  return findings;
}

export function redactSecret(secret: string): string {
  if (secret.length <= 8) return '[REDACTED]';

  const prefixLength = Math.min(4, Math.max(0, secret.indexOf('-') + 1));
  const prefix = secret.slice(0, prefixLength);
  const suffix = secret.slice(-4);
  return `${prefix}[REDACTED:${secret.length}]${suffix}`;
}

export function formatSecretFindings(findings: SecretFinding[]): string {
  if (findings.length === 0) return 'Secret scan passed.';

  const lines = [
    `Secret scan blocked ${findings.length} potential credential${findings.length === 1 ? '' : 's'}.`,
    'The matching values are redacted below. Remove the secret, move it to env/config, or replace it with a placeholder.',
    '',
  ];

  for (const finding of findings) {
    lines.push(
      `${finding.file}:${finding.line}:${finding.column} ${finding.ruleId} - ${finding.description}`,
      `  ${finding.redactedLine}`
    );
  }

  return lines.join('\n');
}

function redactLine(line: string, start: number, length: number): string {
  return `${line.slice(0, start)}${redactSecret(line.slice(start, start + length))}${line.slice(
    start + length
  )}`;
}

function isAllowedPlaceholder(secret: string): boolean {
  return placeholderPatterns.some((pattern) => pattern.test(secret));
}

function isLikelyCodeReference(secret: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(secret);
}

function looksHighEntropy(secret: string): boolean {
  const classes = [
    /[a-z]/.test(secret),
    /[A-Z]/.test(secret),
    /[0-9]/.test(secret),
    /[_./+=-]/.test(secret),
  ].filter(Boolean).length;

  return classes >= 3 && shannonEntropy(secret) >= 3.5;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}
