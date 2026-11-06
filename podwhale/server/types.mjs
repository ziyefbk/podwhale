export function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function inputRecord(value) {
    if (!isRecord(value))
        throw new TypeError('Invalid stored object');
    return value;
}
const string = (value) => typeof value === 'string';
const number = (value) => typeof value === 'number';
const boolean = (value) => typeof value === 'boolean';
const nullableString = (value) => value === null || string(value);
const strings = (value) => Array.isArray(value) && value.every(string);
function fields(record, required, optional = []) {
    return required.every((key) => string(record[key])) && optional.every((key) => record[key] === undefined || string(record[key]));
}
function optional(record, key, guard) { return record[key] === undefined || guard(record[key]); }
export function isAppearance(value) { return isRecord(value) && fields(value, ['shape', 'palette', 'accessory']); }
export function isOwner(value) {
    return isRecord(value) && fields(value, ['id'], ['name', 'handle', 'ownerLabel', 'createdAt', 'bio', 'wechatOpenid', 'wechatBoundAt', 'miniappOpenid', 'miniappBoundAt'])
        && optional(value, 'appearance', (value) => value === null || isAppearance(value)) && optional(value, 'wechatBindingVersion', number) && optional(value, 'miniappBindingVersion', number);
}
function isPost(value) {
    return isRecord(value) && fields(value, ['id', 'title'], ['ownerId', 'text', 'createdAt', 'ai', 'owner', 'kind', 'via', 'emoji', 'source'])
        && optional(value, 'appearance', isAppearance) && ['tags', 'images', 'g'].every((key) => optional(value, key, strings))
        && optional(value, 'redacted', number) && optional(value, 'h', number);
}
function isReply(value) { return isRecord(value) && fields(value, ['id'], ['ownerId', 'ai', 'text', 'createdAt']) && optional(value, 'redacted', number); }
function isClaim(value) { return isRecord(value) && fields(value, ['ownerId'], ['taskId', 'ai', 'note', 'createdAt', 'deliveredAt', 'delivery', 'confirmedAt']) && optional(value, 'redacted', number); }
function isTask(value) {
    return isRecord(value) && fields(value, ['id', 'title'], ['ownerId', 'from', 'fromName', 'ownerLine', 'when', 'desc', 'budget', 'period', 'why', 'source', 'createdAt'])
        && optional(value, 'appearance', isAppearance) && optional(value, 'tags', strings) && optional(value, 'match', number) && optional(value, 'risk', boolean);
}
function isNotification(value) { return isRecord(value) && fields(value, ['id', 'kind'], ['fromName', 'text', 'createdAt', 'to', 'postTitle', 'fromId']) && ['postId', 'taskId', 'refId', 'readAt'].every((key) => optional(value, key, nullableString)); }
function isAsk(value) { return isRecord(value) && fields(value, ['id', 'ownerId', 'text', 'createdAt']) && ['answer', 'answerPostId', 'answeredAt'].every((key) => optional(value, key, nullableString)) && optional(value, 'redacted', number); }
function isReport(value) { return isRecord(value) && fields(value, ['id', 'reason', 'createdAt'], ['by']) && optional(value, 'postId', nullableString) && optional(value, 'targetOwner', nullableString); }
function isPatrol(value) { return isRecord(value) && fields(value, ['at', 'ownerId', 'summary']); }
function isPairing(value) { return isRecord(value) && fields(value, ['code', 'ownerId', 'createdAt', 'expiresAt'], ['role', 'authorizerHash']) && optional(value, 'credentialVersion', number); }
function isRating(value) { return isRecord(value) && fields(value, ['id', 'taskId', 'fromOwner', 'toOwner', 'text', 'createdAt']) && number(value.score); }
function isPayload(value) { return isRecord(value) && fields(value, [], ['id', 'taskId', 'postId', 'replyId']) && optional(value, 'images', strings); }
function isProposal(value) { return isRecord(value) && fields(value, ['id', 'ownerId', 'action', 'createdAt', 'expiresAt', 'status'], ['digest', 'targetDigest', 'decidedAt']) && isPayload(value.payload); }
function arrayOf(value, guard) {
    if (!Array.isArray(value) || !value.every(guard))
        throw new TypeError('Invalid stored collection');
    return value;
}
function mapOf(value, guard) {
    const source = inputRecord(value);
    const result = {};
    for (const [key, item] of Object.entries(source)) {
        if (!guard(item))
            throw new TypeError('Invalid stored collection entry');
        result[key] = item;
    }
    return result;
}
export function ownerRegistry(value) { return mapOf(value, isOwner); }
export function feedState(value) {
    const raw = inputRecord(value);
    for (const key of ['seeded', 'tasksSeeded']) {
        if (key in raw && !boolean(raw[key]))
            throw new TypeError('Invalid stored seed metadata');
    }
    const reaction = (value) => isRecord(value) && optional(value, 'like', boolean) && optional(value, 'save', boolean);
    const reactions = mapOf(raw.reactions || {}, isRecord);
    const typedReactions = {};
    for (const [key, value] of Object.entries(reactions))
        typedReactions[key] = mapOf(value, reaction);
    const result = {
        version: number(raw.version) ? raw.version : 1,
        posts: arrayOf(raw.posts ?? [], isPost), comments: mapOf(raw.comments || {}, (value) => Array.isArray(value) && value.every(isReply)),
        claims: mapOf(raw.claims || {}, isClaim), reactions: typedReactions,
        notifications: arrayOf(Array.isArray(raw.notifications) ? raw.notifications : [], isNotification), asks: arrayOf(Array.isArray(raw.asks) ? raw.asks : [], isAsk),
        tasks: arrayOf(Array.isArray(raw.tasks) ? raw.tasks : [], isTask), follows: mapOf(raw.follows || {}, isRecord), blocks: mapOf(raw.blocks || {}, isRecord),
        reports: arrayOf(Array.isArray(raw.reports) ? raw.reports : [], isReport), patrols: arrayOf(Array.isArray(raw.patrols) ? raw.patrols : [], isPatrol),
        pairings: arrayOf(Array.isArray(raw.pairings) ? raw.pairings : [], isPairing), ratings: arrayOf(Array.isArray(raw.ratings) ? raw.ratings : [], isRating),
        proposals: arrayOf(Array.isArray(raw.proposals) ? raw.proposals : [], isProposal), updatedAt: nullableString(raw.updatedAt) ? raw.updatedAt : null,
    };
    if (boolean(raw.seeded))
        result.seeded = raw.seeded;
    if (boolean(raw.tasksSeeded))
        result.tasksSeeded = raw.tasksSeeded;
    return Object.assign(raw, result);
}
export function errorStatus(value, fallback = 500) { return isRecord(value) && typeof value.status === 'number' ? value.status : fallback; }
export function errorMessage(value) { return isRecord(value) && value.message ? String(value.message) : String(value); }
