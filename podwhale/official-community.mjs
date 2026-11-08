import { communityEndpoint } from './community-endpoint.mjs';
/** Public product endpoint only; account credentials never belong here. */
export const DEFAULT_COMMUNITY_URL = "https://43.142.58.230/xiaolanshu";
/** An existing explicit target never inherits authority from another server. */
export function resolveCommunityTarget(explicitUrl, officialUrl = DEFAULT_COMMUNITY_URL) {
    if (explicitUrl !== undefined)
        return communityEndpoint(explicitUrl);
    if (!officialUrl)
        throw Object.assign(new Error('官方社区入口尚未配置'), { code: 'community_official_unavailable', status: 503 });
    return communityEndpoint(officialUrl);
}
