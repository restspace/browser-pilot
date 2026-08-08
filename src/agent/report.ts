import { Ajv, type ValidateFunction } from 'ajv';

export interface Report {
  status: 'success' | 'failure' | 'blocked';
  summary: string;
  details?: string;
  evidence?: {
    url?: string;
    capturedDialogs?: string[];
    values?: Record<string, string | number | boolean | null>;
  };
}

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['success', 'failure', 'blocked'] },
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    details: { type: 'string' },
    evidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string' },
        capturedDialogs: { type: 'array', items: { type: 'string' } },
        values: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
    },
  },
} as const;

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
    compiled = ajv.compile(REPORT_SCHEMA);
  }
  return compiled;
}

export type ReportValidation = { ok: true; report: Report } | { ok: false; error: string };

/**
 * Validate the agent's `report` tool call. Providers vary in how strictly
 * they honour tool schemas, so on invalid output the loop feeds this error
 * back for one retry turn before declaring the instruction blocked.
 */
export function validateReport(input: unknown): ReportValidation {
  const validate = validator();
  if (validate(input)) return { ok: true, report: input as Report };
  const error = (validate.errors ?? [])
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
    .join('; ');
  return { ok: false, error: error || 'report did not match the required schema' };
}
