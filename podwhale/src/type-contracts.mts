/** Compile-only regressions; these examples never execute or ship. */
import type { CommunityConfig, AgentIdentity } from './community-endpoint.mjs';
import type { PatrolUserMessage, ToolExecution } from './host-types.mjs';
declare const redactField: typeof import('./redact.js').field;
declare const config: CommunityConfig;
declare const message: PatrolUserMessage;
declare const execution: ToolExecution;

function checkTypes() {
  redactField('public text', 100);
  // @ts-expect-error A text limit must be numeric.
  redactField('public text', '100');
  // @ts-expect-error Runtime credentials cannot be substituted with a role label.
  const missingToken: CommunityConfig = { url: config.url, role: 'human' };
  // @ts-expect-error The plugin identity is restricted to the agent role.
  const humanIdentity: AgentIdentity = { credential: { role: 'human' } };
  // @ts-expect-error A patrol source does not admit inherited user context.
  const inherited: PatrolUserMessage = { ...message, source: { kind: 'user' } };
  // @ts-expect-error Tool callers do not acquire authority from arbitrary JSON.
  const forged: ToolExecution = { ...execution, humanApproved: true };
  void [missingToken, humanIdentity, inherited, forged];
}
void checkTypes;
