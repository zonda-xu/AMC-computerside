import { Ajv } from 'ajv';
import { readFileSync } from 'node:fs';
import { ENGINES } from './types.ts';
import type { Command, ConsoleEvent, WorkspaceCreateRequest, FormField, EventType } from './types.ts';
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
   properties: { protocolVersion: { const: 2 }, hostId: id, clientRequestId: id, sessionId: id, ref: refSchema, action: { enum: ['submit','cancel','decide','configure','slash','steer'] }, payload: { type: 'object', required:['expectedGeneration'], properties:{expectedGeneration:{type:'integer',minimum:0}} } },
   allOf:[{if:{properties:{action:{const:'cancel'}}},then:{properties:{payload:{type:'object',required:['runId'],properties:{runId:id}}}}},{if:{properties:{action:{const:'decide'}}},then:{properties:{payload:{type:'object',required:['interactionId'],properties:{interactionId:id,answer:{type:'object'}}}}}}]
};
export const validateCommand = new Ajv({ allErrors: true }).compile<Command>(commandSchema);
const payloadAjv=new Ajv({allErrors:true});
interface EventSchemaSource { definitions: Record<EventType, object>; properties: { data: object } }
const eventSchema: EventSchemaSource = JSON.parse(readFileSync(new URL('../schema/event.schema.json',import.meta.url),'utf8'));
export const eventPayloadSchemas=eventSchema.definitions;
export const validateConsoleEvent=payloadAjv.compile<ConsoleEvent>(eventSchema);
const validateEventMetadata=payloadAjv.compile(eventSchema.properties.data);
const eventPayloadValidators=Object.fromEntries(Object.entries(eventPayloadSchemas).map(([type,schema])=>[type,payloadAjv.compile(schema)]));
export function validateEventData(type:EventType,data:Record<string,unknown>):void{
  const validate=eventPayloadValidators[type];requireValue(validate&&validate(data),'invalid_event',`Invalid ${type} payload: ${JSON.stringify(validate?.errors)}`);
  requireValue(validateEventMetadata(data),'invalid_event',`Invalid ${type} metadata: ${JSON.stringify(validateEventMetadata.errors)}`);
  if(data.generation!==undefined)requireValue(Number.isSafeInteger(data.generation)&&(data.generation as number)>=0,'invalid_event','Invalid event generation');
  if(data.runId!==undefined)string(data.runId,'runId');
  if(data.nativeRunId!==undefined)string(data.nativeRunId,'nativeRunId',500);
  if(data.nativeEventId!==undefined)string(data.nativeEventId,'nativeEventId',500);
}
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
export function validateFormAnswer(fields:FormField[],answer:Record<string,unknown>):void{
  for(const key of Object.keys(answer))requireValue(fields.some(f=>f.key===key),'question_invalid','Unknown form field');
  for(const f of fields){
    const visible=!f.hidden&&(!f.when||f.when.every(w=>w.op==='eq'?answer[w.key]===w.value:answer[w.key]!==w.value));
    const value=answer[f.key];
    if(!visible){requireValue(value===undefined,'answer_invalid','Hidden field cannot be answered');continue;}
    if(value===undefined){requireValue(!f.required,'answer_invalid',`Required field: ${f.key}`);continue;}
    let valid=false;
    if(f.type==='string')valid=typeof value==='string'&&value.length<=(f.maxLength??10000)&&value.length>=(f.minLength??0)&&(!f.pattern||new RegExp(f.pattern).test(value))&&(!f.options||f.custom===true||f.options.some(o=>o.value===value));
    if(f.type==='number'||f.type==='integer')valid=typeof value==='number'&&Number.isFinite(value)&&(f.type!=='integer'||Number.isSafeInteger(value))&&value>=(f.minimum??-Infinity)&&value<=(f.maximum??Infinity);
    if(f.type==='boolean')valid=typeof value==='boolean';
    if(f.type==='multiselect')valid=Array.isArray(value)&&value.length>=(f.minItems??0)&&value.length<=(f.maxItems??100)&&new Set(value).size===value.length&&value.every(v=>typeof v==='string'&&v.length<=10000&&(f.custom===true||f.options?.some(o=>o.value===v)));
    requireValue(valid,'answer_invalid',`Invalid form field: ${f.key}`);
  }
}
