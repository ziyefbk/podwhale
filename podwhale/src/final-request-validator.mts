/**
 * Admission of the final DSH LLM envelope, immediately before adapter dispatch.
 *
 * Shapes follow the installed DSH message factories and ToolHistoryProjection:
 * messages carry role/content/source; tool results reference both source.callId
 * and toolCallId; toolHistory is { tools, updates }, not conversation messages.
 * Every policy value and executedCalls comes from the Host controller. A source
 * label in request content, or an object supplied as tool arguments, is never
 * an authorization credential.
 */
import { isDeepStrictEqual } from 'node:util';

const TOOL_NAMES = Object.freeze([
  'xlb_feed', 'xlb_post', 'xlb_reply', 'xlb_claim', 'xlb_deliver',
  'xlb_confirm', 'xlb_answer', 'xlb_patrol',
]);
const TOOL_SET = new Set(TOOL_NAMES);
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const REJECTION = 'Podwhale isolation rejected an unexpected model request';
const POLICY_STAGES = new Set(['policy_config', 'request_route', 'tool_schemas', 'tool_history',
  'message_structure', 'system_message', 'user_message', 'assistant_message', 'tool_message']);

function rejected(policyStage: string = 'policy_config') {
  return Object.assign(new Error(REJECTION), { code: 'PODWHALE_ISOLATION_REQUEST', status: 403,
    policyStage: POLICY_STAGES.has(policyStage) ? policyStage : 'policy_config' });
}
function requireCondition(ok: unknown): asserts ok { if (!ok) throw rejected(); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function array(value: unknown): value is unknown[] { return Array.isArray(value); }
function exactNames(names: unknown): names is string[] {
  return array(names) && names.length === TOOL_NAMES.length
    && new Set(names).size === TOOL_NAMES.length && names.every((name) => typeof name === 'string' && TOOL_SET.has(name));
}
function textOnly(content: unknown): content is { type: 'text'; text: string }[] {
  return array(content) && content.every((block) => record(block)
    && block.type === 'text' && typeof block.text === 'string');
}
function singleText(content: unknown, expected: unknown) {
  return textOnly(content) && content.length === 1 && content[0]?.text === expected;
}
function toolCallArguments(raw: unknown) {
  // DSH BlockAssembler retains the model's JSON string in history. Only its
  // execution pipeline parses that string; an empty input maps to {} there.
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) return false;
  try { return record(raw ? JSON.parse(raw) : {}); } catch { return false; }
}

function schemaMap(schemas: unknown) {
  requireCondition(array(schemas) && exactNames(schemas.map((schema) => record(schema) ? schema.name : undefined)));
  const map = new Map<string, Record<string, unknown>>();
  for (const schema of schemas) {
    requireCondition(record(schema) && typeof schema.name === 'string' && typeof schema.description === 'string'
      && record(schema.parameters) && Object.keys(schema).every((key) => ['name', 'description', 'parameters', 'deferLoading'].includes(key))
      && (!Object.hasOwn(schema, 'deferLoading') || schema.deferLoading === true));
    map.set(schema.name, schema);
  }
  return map;
}

function sameSchemas(actual: unknown, expected: ReadonlyMap<string, Record<string, unknown>>) {
  const map = schemaMap(actual);
  for (const [name, schema] of expected) requireCondition(isDeepStrictEqual(map.get(name), schema));
}

/**
 * The controller must filter by its private session map before calling this.
 * `toolSchemas` is a Host-owned snapshot of the audited native capability set;
 * `executedCalls` is a Host-owned Map<callId, {name}> populated by its guard.
 * Returns true, or a fixed error that never echoes rejected context or secrets.
 */
export function assertPatrolRequest(request: unknown, policy: unknown) {
  let policyStage = 'policy_config';
  try {
    requireCondition(record(request) && record(policy)
      && nonempty(policy.sessionId) && nonempty(policy.provider) && nonempty(policy.model)
      && nonempty(policy.systemText) && nonempty(policy.initialUserText)
      && record(policy.initialUserSource) && nonempty(policy.initialUserSource.kind)
      && policy.initialUserSource.kind !== 'runtime-context'
      && policy.initialUserSource.kind !== 'agent-instructions'
      && policy.executedCalls instanceof Map
      && (policy.mode === undefined || policy.mode === 'social')
      && (policy.mode !== 'social' || (typeof policy.allowPosts === 'boolean' && typeof policy.allowReplies === 'boolean')));
    policyStage = 'request_route';
    requireCondition(request.sessionId === policy.sessionId
      && request.provider === policy.provider && request.model === policy.model);
    policyStage = 'tool_schemas';
    requireCondition(policy.toolNames === undefined || exactNames(policy.toolNames));
    const expectedSchemas = schemaMap(policy.toolSchemas);
    sameSchemas(request.tools, expectedSchemas);
    policyStage = 'tool_history';
    requireCondition(record(request.toolHistory) && array(request.toolHistory.updates)
      && request.toolHistory.updates.length === 0);
    sameSchemas(request.toolHistory.tools, expectedSchemas);

    policyStage = 'message_structure';
    const messages = request.messages;
    requireCondition(array(messages) && messages.length >= 2);
    requireCondition(record(messages[0]) && messages[0].role === 'system' && record(messages[1]) && messages[1].role === 'user');
    const messageIds = new Set<string>();
    const calls = new Map<string, string>();
    const pending = new Set<string>();
    const results = new Set<string>();
    let systemMessages = 0;
    let userMessages = 0;
    let writes = 0;
    let feedCalls = 0;

    for (const message of messages) {
      policyStage = 'message_structure';
      requireCondition(record(message) && nonempty(message.id) && !messageIds.has(message.id)
        && record(message.source) && array(message.content));
      messageIds.add(message.id);
      if (message.role === 'system') {
        policyStage = 'system_message';
        systemMessages += 1;
        requireCondition(systemMessages === 1
          && isDeepStrictEqual(message.source, { kind: 'system-prompt' })
          && singleText(message.content, policy.systemText));
      } else if (message.role === 'user') {
        policyStage = 'user_message';
        userMessages += 1;
        requireCondition(userMessages === 1
          && isDeepStrictEqual(message.source, policy.initialUserSource)
          && singleText(message.content, policy.initialUserText));
      } else if (message.role === 'assistant') {
        policyStage = 'assistant_message';
        requireCondition(pending.size === 0 && message.source.kind === 'model'
          && message.source.provider === policy.provider && message.source.model === policy.model);
        for (const block of message.content) {
          requireCondition(record(block));
          if (block.type === 'text' || block.type === 'reasoning') {
            requireCondition(typeof block.text === 'string');
            continue;
          }
          requireCondition(block.type === 'tool-call' && nonempty(block.id) && block.id.length <= 512
            && typeof block.name === 'string' && TOOL_SET.has(block.name) && !calls.has(block.id) && toolCallArguments(block.arguments));
          if (policy.mode === 'social') requireCondition(block.name === 'xlb_feed'
            || block.name === 'xlb_post' && policy.allowPosts === true
            || block.name === 'xlb_reply' && policy.allowReplies === true);
          if (policy.mode === 'social' && block.name === 'xlb_feed') requireCondition(++feedCalls <= 1);
          calls.set(block.id, block.name);
          pending.add(block.id);
          if (block.name !== 'xlb_feed') writes += 1;
          requireCondition(calls.size <= 8 && writes <= 3);
        }
      } else if (message.role === 'tool') {
        policyStage = 'tool_message';
        const callId = message.toolCallId;
        const actual: unknown = policy.executedCalls.get(callId);
        requireCondition(message.source.kind === 'tool' && message.source.callId === callId
          && nonempty(callId) && calls.has(callId) && pending.has(callId) && !results.has(callId)
          && record(actual) && actual.name === calls.get(callId)
          && typeof message.isError === 'boolean' && textOnly(message.content));
        if (policy.mode === 'social' && actual.name !== 'xlb_feed' && (actual.receipt !== undefined || message.isError === false)) {
          requireCondition(message.isError === false && record(actual.receipt) && message.content.length === 1);
          const content = message.content[0];
          requireCondition(content && Buffer.byteLength(content.text, 'utf8') <= 4096);
          const receipt: unknown = JSON.parse(content.text);
          requireCondition(isDeepStrictEqual(receipt, actual.receipt));
        }
        pending.delete(callId);
        results.add(callId);
      } else {
        // Fixed tools and a fixed route need no dynamic developer instructions,
        // tool-registry updates, inherited user input, or injected runtime facts.
        throw rejected();
      }
    }
    policyStage = 'message_structure';
    requireCondition(systemMessages === 1 && userMessages === 1);
    policyStage = 'tool_message';
    requireCondition(pending.size === 0);
    return true;
  } catch {
    throw rejected(policyStage);
  }
}
