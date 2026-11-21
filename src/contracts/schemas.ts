// 契约运行时校验：编译 contract.v1.schema.json 全部20个定义（AJV 严格模式）。
// 共享TS类型不代替运行时校验——所有跨边界对象必须经此校验后使用。
import type { ValidateFunction } from 'ajv';
import { createRequire } from 'node:module';

interface AjvLike { getSchema(key: string): ValidateFunction | undefined }
const require_ = createRequire(import.meta.url);
const Ajv = require_('ajv') as unknown as new (options?: Record<string, unknown>) => AjvLike;
const addFormats = require_('ajv-formats') as (ajv: AjvLike, formats?: string[]) => AjvLike;
import contractSchema from '../../contracts/contract.v1.schema.json' with { type: 'json' };

export const CONTRACT_URN = 'urn:debate-workbench:contracts:v1';
export type ContractDefinitionName =
  | 'ResourceRef' | 'GrantRef' | 'RoleBindingInput' | 'CreateRun' | 'ModelParameters'
  | 'ModelEntryInput' | 'ModelConfigInput' | 'CredentialInput' | 'SupplementInput'
  | 'ApprovalDecision' | 'ContextManifest' | 'Limits' | 'Capability' | 'TaskSpec'
  | 'RunEvent' | 'ToolResult' | 'TaskDelivery' | 'ReportClaim' | 'Report' | 'ErrorResponse';

const ajv = new Ajv({
  strict: true,
  allErrors: true,
  coerceTypes: false,       // 显式关闭类型强转（规格要求）
  removeAdditional: false,  // 显式关闭字段移除——未知字段直接拒绝
  schemas: [contractSchema as object],
});
addFormats(ajv); // date-time / uri 等 format 关键字按标准校验

export interface Validated<T> { ok: true; value: T }
export interface Rejected { ok: false; errors: string[] }
export type ValidationResult<T> = Validated<T> | Rejected;

export function validatorOf(name: ContractDefinitionName): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_URN}#/definitions/${name}`);
  if (!v) throw new Error(`CONTRACT_DEFINITION_MISSING: ${name}`);
  return v;
}

export function validate<T>(name: ContractDefinitionName, input: unknown): ValidationResult<T> {
  const v = validatorOf(name);
  if (v(input)) return { ok: true, value: input as T };
  return { ok: false, errors: (v.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()) };
}

export const validateCreateRun = (input: unknown) => validate<import('../../contracts/v1.js').CreateRun>('CreateRun', input);
export const validateSupplementInput = (input: unknown) => validate<import('../../contracts/v1.js').SupplementInput>('SupplementInput', input);
export const validateRunEvent = (input: unknown) => validate<import('../../contracts/v1.js').RunEvent>('RunEvent', input);
export const validateModelConfigInput = (input: unknown) => validate<import('../../contracts/v1.js').ModelConfigInput>('ModelConfigInput', input);
export const validateApprovalDecision = (input: unknown) => validate<import('../../contracts/v1.js').ApprovalDecision>('ApprovalDecision', input);
export const validateToolResult = (input: unknown) => validate<import('../../contracts/v1.js').ToolResult>('ToolResult', input);
export const validateTaskDelivery = (input: unknown) => validate<import('../../contracts/v1.js').TaskDelivery>('TaskDelivery', input);
