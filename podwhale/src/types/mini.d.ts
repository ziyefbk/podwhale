/** The WeChat APIs and community fields used by this mini program only. */
interface MiniPost { id: string; kind: string; title: string; text: string; ai: string; ownerId?: string; likes?: number; replies?: number }
interface MiniTask { id: string; title: string; budget: string; match: number; claimed?: boolean }
interface MiniAsk { id: string; text: string; answer?: string }
interface MiniStats { posts: number; replies: number; claims: number; followers: number }
interface MiniPatrol { at: string; summary: string }
interface MiniDigest {
  mine: { posts: number; replies: number; claims: number };
  incoming: { likes: number; replies: number; follows: number };
  pending: { asks: number };
}
interface MiniFeed { posts?: MiniPost[]; tasks?: MiniTask[]; stats?: MiniStats; patrols?: MiniPatrol[] }
interface MiniLogin { token?: string }
interface MiniAsks { items?: MiniAsk[] }
interface MiniDigestBody { digest?: MiniDigest | null }
interface MiniError { error?: string }
type MiniBody = MiniFeed & MiniLogin & MiniAsks & MiniDigestBody & MiniError;
interface MiniResult<T extends object = MiniBody> { ok: boolean; status: number; data: T & MiniError }
type MiniMethod = 'GET' | 'POST';
type MiniPath = `/feed${string}` | '/wxapp/login' | '/wxapp/bind' | '/asks' | '/digest'
  | '/post' | '/delete' | '/claim' | '/ask' | '/ask/delete';
type MiniResponse<P extends MiniPath> = P extends `/feed${string}` ? MiniFeed
  : P extends '/wxapp/login' | '/wxapp/bind' ? MiniLogin
  : P extends '/asks' ? MiniAsks : P extends '/digest' ? MiniDigestBody : MiniError;
interface MiniApi {
  BASE: string;
  request<P extends MiniPath>(path: P, method?: MiniMethod, data?: object): Promise<MiniResult<MiniResponse<P>>>;
}
declare function require(path: './utils/api.js' | '../../utils/api.js'): MiniApi;
declare const module: { exports: MiniApi };
interface MiniTapEvent<K extends string> { currentTarget: { dataset: { [P in K]: string } } }
interface MiniInputEvent { detail: { value: string } }
interface MiniAppData { token: string; needBind: boolean; error: string }
interface MiniApp {
  globalData: MiniAppData;
  login(): Promise<MiniResult<MiniLogin>>;
  bind(pair: string): Promise<MiniResult<MiniLogin>>;
}
declare function getApp(): MiniApp;
declare function App<T extends MiniApp>(options: T & ThisType<T>): void;
declare function Page<D extends object, M extends object>(options: { data: D } & M
  & ThisType<M & { data: D; setData(update: Partial<D>): void }>): void;
interface MiniFeedState {
  kinds: string[]; kind: string; notes: MiniPost[]; shown: MiniPost[]; needBind: boolean; bindCode: string;
  loading: boolean; open: string; error: string; draftTitle: string; draftText: string; draftKind: string; composing: boolean;
}
interface MiniTasksState { tasks: MiniTask[]; loading: boolean; error: string }
interface MiniAsksState { asks: MiniAsk[]; draft: string; loading: boolean; error: string }
interface MiniMeState { stats: MiniStats; digest: MiniDigest | null; patrols: MiniPatrol[]; loading: boolean }
declare const wx: {
  login(options: { success(result: { code: string }): void; fail(): void }): void;
  getStorageSync(key: 'xlb-token'): string | undefined;
  setStorageSync(key: 'xlb-token', value: string): void;
  stopPullDownRefresh(): void;
  showToast(options: { title: string; icon: 'none' | 'success' }): void;
  showModal(options: { title: string; content: string; showCancel?: boolean; success?(result: { confirm: boolean }): void }): void;
  request(options: { url: string; method: MiniMethod; header: { authorization?: string }; data: object | undefined;
    success(result: { statusCode: number; data: unknown }): void; fail(): void }): void;
};
