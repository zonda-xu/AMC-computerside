import { Ajv } from 'ajv';
import { ENGINES } from './types.ts';
import type { Command, WorkspaceCreateRequest } from './types.ts';
export class Fault extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export function requireValue(test: unknown, code: string, message: string, status = 400): asserts test {
  if (!test) throw new Fault(status, code, message);
}
const id = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_.:-]+$' };
export const refSchema = { type: 'object', additionalProperties: false, required: ['hostId','workspaceId','runtimeInstanceId','engineId','nativeSessionId'], properties: { hostId: id, workspaceId: id, runtimeInstanceId: id, engineId: { enum: ENGINES }, nativeSessionId: { type: 'string', minLength: 1, maxLength: 500 } } };
export const commandSchema = {
  type: 'object', additionalProperties: false,
  required: ['protocolVersion','hostId','clientRequestId','sessionId','ref','action','payload'],
  properties: { protocolVersion: { const: 1 }, hostId: id, clientRequestId: id, sessionId: id, ref: refSchema, action: { enum: ['submit','cancel','decide','configure'] }, payload: { type: 'object' } }
};
export const validateCommand = new Ajv({ allErrors: true }).compile<Command>(commandSchema);
export const workspaceCreateSchema = {
  type: 'object', additionalProperties: false,
  required: ['clientRequestId','rootId','directoryName','name'],
  properties: {
    clientRequestId: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_.:-]+$' },
    rootId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    directoryName: { type: 'string', minLength: 1, maxLength: 100 },
    name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }
  }
};
export const validateWorkspaceCreate = new Ajv({ allErrors: true }).compile<WorkspaceCreateRequest>(workspaceCreateSchema);
export function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_object', 'Expected JSON object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string, max = 200): string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'invalid_field', `Invalid ${name}`);
  return value;
}
export function exactRef(a: object, b: object): boolean { return stable(a) === stable(b); }
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
