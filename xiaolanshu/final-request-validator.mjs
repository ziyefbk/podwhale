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
const REJECTION = 'Podwhale isolation rejected an unexpected model request';
const POLICY_STAGES = new Set(['policy_config', 'request_route', 'tool_schemas', 'tool_history',
  'message_structure', 'system_message', 'user_message', 'assistant_message', 'tool_message']);

function rejected(policyStage = 'policy_config') {
  return Object.assign(new Error(REJECTION), { code: 'PODWHALE_ISOLATION_REQUEST', status: 403,
    policyStage: POLICY_STAGES.has(policyStage) ? policyStage : 'policy_config' });
}
function requireCondition(ok) { if (!ok) throw rejected(); }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value) { return typeof value === 'string' && value.length > 0; }
function exactNames(names) {
  return Array.isArray(names) && names.length === TOOL_NAMES.length
    && new Set(names).size === TOOL_NAMES.length && names.every((name) => TOOL_SET.has(name));
}
function textOnly(content) {
  return Array.isArray(content) && content.every((block) => record(block)
    && block.type === 'text' && typeof block.text === 'string');
}
function singleText(content, expected) {
  return textOnly(content) && content.length === 1 && content[0].text === expected;
}

function schemaMap(schemas) {
  requireCondition(Array.isArray(schemas) && exactNames(schemas.map((schema) => schema?.name)));
  const map = new Map();
  for (const schema of schemas) {
    requireCondition(record(schema) && typeof schema.description === 'string'
      && record(schema.parameters) && Object.keys(schema).every((key) => ['name', 'description', 'parameters', 'deferLoading'].includes(key))
      && (!Object.hasOwn(schema, 'deferLoading') || schema.deferLoading === true));
    map.set(schema.name, schema);
  }
  return map;
}

function sameSchemas(actual, expected) {
  const map = schemaMap(actual);
  for (const [name, schema] of expected) requireCondition(isDeepStrictEqual(map.get(name), schema));
}

/**
 * The controller must filter by its private session map before calling this.
 * `toolSchemas` is a Host-owned snapshot of the audited native capability set;
 * `executedCalls` is a Host-owned Map<callId, {name}> populated by its guard.
 * Returns true, or a fixed error that never echoes rejected context or secrets.
 */
export function assertPatrolRequest(request, policy) {
  let policyStage = 'policy_config';
  try {
    requireCondition(record(request) && record(policy)
      && nonempty(policy.sessionId) && nonempty(policy.provider) && nonempty(policy.model)
      && nonempty(policy.systemText) && nonempty(policy.initialUserText)
      && record(policy.initialUserSource) && nonempty(policy.initialUserSource.kind)
      && policy.initialUserSource.kind !== 'runtime-context'
      && policy.initialUserSource.kind !== 'agent-instructions'
      && policy.executedCalls instanceof Map);
    policyStage = 'request_route';
    requireCondition(request.sessionId === policy.sessionId
      && request.provider === policy.provider && request.model === policy.model);
    policyStage = 'tool_schemas';
    requireCondition(policy.toolNames === undefined || exactNames(policy.toolNames));
    const expectedSchemas = schemaMap(policy.toolSchemas);
    sameSchemas(request.tools, expectedSchemas);
    policyStage = 'tool_history';
    requireCondition(record(request.toolHistory) && Array.isArray(request.toolHistory.updates)
      && request.toolHistory.updates.length === 0);
    sameSchemas(request.toolHistory.tools, expectedSchemas);

    policyStage = 'message_structure';
    const messages = request.messages;
    requireCondition(Array.isArray(messages) && messages.length >= 2);
    requireCondition(messages[0]?.role === 'system' && messages[1]?.role === 'user');
    const messageIds = new Set();
    const calls = new Map();
    const pending = new Set();
    const results = new Set();
    let systemMessages = 0;
    let userMessages = 0;
    let writes = 0;

    for (const message of messages) {
      policyStage = 'message_structure';
      requireCondition(record(message) && nonempty(message.id) && !messageIds.has(message.id)
        && record(message.source) && Array.isArray(message.content));
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
            && TOOL_SET.has(block.name) && !calls.has(block.id) && record(block.arguments));
          calls.set(block.id, block.name);
          pending.add(block.id);
          if (block.name !== 'xlb_feed') writes += 1;
          requireCondition(calls.size <= 8 && writes <= 3);
        }
      } else if (message.role === 'tool') {
        policyStage = 'tool_message';
        const callId = message.toolCallId;
        const actual = policy.executedCalls.get(callId);
        requireCondition(message.source.kind === 'tool' && message.source.callId === callId
          && nonempty(callId) && calls.has(callId) && pending.has(callId) && !results.has(callId)
          && record(actual) && actual.name === calls.get(callId)
          && typeof message.isError === 'boolean' && textOnly(message.content));
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
