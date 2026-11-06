/** The small DSH Host surface exercised by the contract/security tests. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Dispose = () => void | Promise<void>;
export interface TextBlock { readonly type: 'text'; readonly text: string }
export interface PatrolUserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly source: { readonly kind: 'podwhale-patrol' };
  readonly content: readonly TextBlock[];
}
export interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens: number;
}
export interface ToolExecution {
  agent?: HostAgent;
  signal?: AbortSignal;
  name?: string;
  callId?: unknown;
}
export interface ToolGuardExecution extends ToolExecution { agent: HostAgent; name: string }
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferLoading?: true;
}
export interface ToolOutput {
  schema: Record<string, unknown>;
  render(args: unknown, value: unknown): TextBlock[];
}
export interface ToolDefinition extends ToolSchema {
  output?: ToolOutput;
  execute?(args: unknown, execution?: ToolExecution): Promise<unknown>;
}
export interface RegisteredTool extends ToolDefinition {
  execute(args: unknown, execution?: ToolExecution): Promise<unknown>;
}
export interface ToolExecutor {
  describe(definitions: readonly ToolDefinition[]): { schemas?: ToolSchema[] };
}
export interface ScopedTools {
  definitions(agent: HostAgent): ToolDefinition[];
  selectExecutor(agent: HostAgent): ToolExecutor;
  restrict(filter: { allow: string[] }): unknown;
  guard(check: (execution: ToolGuardExecution) => string | undefined): unknown;
}
export interface PromptPart { name: string; text?: string }
export interface PromptAssembly {
  sections?: PromptPart[];
  contexts?: PromptPart[];
  tools?: ToolSchema[];
}
export interface AgentModelContext { agent: HostAgent; scope: HostAgent; modelSelection: ModelRoute }
export interface SystemPrompt {
  section(section: { name: string; order: number; complete: boolean; interpolate: boolean; text: string }): unknown;
  context(context: { name: string; order: number; required: boolean; interpolate: boolean; text: string }): unknown;
  suppressRuntimeContext(): unknown;
  assemble(context: AgentModelContext): Promise<PromptAssembly>;
  refreshContext(assembly: PromptAssembly, context: AgentModelContext): PromptAssembly;
}
export interface AgentContext {
  tools: ScopedTools;
  systemPrompt: SystemPrompt;
  on(event: 'system-prompt/assemble', handler: (assembly: PromptAssembly, context: AgentModelContext,
    next: () => Promise<PromptAssembly>) => Promise<PromptAssembly>, options: { prepend: true }): Dispose;
}
export interface HostAgent {
  ctx: AgentContext;
  model?: { current?: () => unknown };
  followup(message: PatrolUserMessage): unknown;
  whenIdle(): Promise<unknown>;
  cancel(reason: { kind: 'disposed' }): unknown;
  inbox?: { remove?: (messageId: string) => unknown };
}
export interface AgentHandle { agent: HostAgent; dispose(): void | Promise<void> }
export interface AgentCreateOptions {
  sessionId: string;
  meta: { cwd: string; agentPreset: string };
  agentOptions: ModelRoute;
  signal: AbortSignal;
  setup(context: AgentContext, agent: HostAgent): Promise<void>;
}
export interface AgentPresets {
  register(preset: { id: string; name: string; plugins: { id: string; name: string }[] }): Promise<Dispose>;
  mount(context: AgentContext, id: string): Promise<{ id: string } | null>;
  list(): Promise<{ id: string; broken?: unknown }[]>;
  composedPreset(context: AgentContext): string | undefined;
}
export interface EffectContext { effect(create: () => Dispose): unknown }
export interface PatrolRuntimeContext extends EffectContext {
  agents: { create(options: AgentCreateOptions): Promise<AgentHandle>; get?(sessionId: string): Pick<HostAgent, 'inbox'> | undefined };
  agentPresets: AgentPresets;
  agentDefaultModel?: { currentSelection?: () => unknown };
  on(event: 'llm/stream', handler: (request: unknown, next: () => unknown) => unknown,
    options: { global: true }): Dispose;
}
export interface ScheduleService {
  view(query: { id: string }): Promise<unknown>;
  edit(change: { id: string; action: 'update'; patch: { active: false; prompt: string }; expectedUpdatedAt: unknown }): Promise<unknown>;
}
export interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}
export interface WebServer {
  register(route: WebRoute): Dispose;
  getOrigin?(): string | null | Promise<string | null>;
}
export interface HostContext extends EffectContext {
  inject(names: ['agents', 'agentPresets', 'agentDefaultModel'], activate: (context: PatrolRuntimeContext) => void | Promise<void>): unknown;
  inject(names: ['schedule'], activate: (context: EffectContext & { schedule: ScheduleService }) => void | Promise<void>): unknown;
  inject(names: ['tools'], activate: (context: { tools: { register(tool: RegisteredTool): Dispose } }) => void): unknown;
  inject(names: ['webServer'], activate: (context: { webServer: WebServer }) => void): unknown;
}
