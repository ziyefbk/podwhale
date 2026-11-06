/**
 * 存储层：SQLite（Node 内置 node:sqlite，零依赖）。
 *
 * 设计取舍：
 * - 一个通用行表 `entities(collection, key, data)`。**每行是一条实体**，
 *   写一条帖子只碰一行，不再重写整个 2 MB 的文件。
 * - 数组型集合按 id 分行；对象型集合（comments/claims/reactions/...）按外层键分行。
 * - 全部写入在一个事务里；`synchronous=FULL` + WAL，落盘前不会丢。
 * - 领域代码仍然用内存里的 state 对象工作（读路径不变），
 *   这里只负责"把变化的行写进数据库"。
 *
 * 这是第一步：先让存储可靠。第二步再把热查询（分页、搜索）下推到 SQL。
 */
import { DatabaseSync } from 'node:sqlite';
function property(value, key) {
    if (value == null)
        return undefined;
    const boxed = Object(value);
    return Reflect.get(boxed, key);
}
function entries(value) {
    const boxed = Object(value ?? {});
    return Object.entries(boxed);
}
function textColumn(row, key) {
    const value = row[key];
    if (typeof value !== 'string')
        throw new TypeError('Invalid stored text column');
    return value;
}
function parseJson(text) { return JSON.parse(text); }
function stringify(value) {
    const text = JSON.stringify(value);
    if (text === undefined)
        throw new TypeError('Value cannot be stored as JSON');
    return text;
}
function isRowsSnapshot(value) {
    if (!(property(value, 'posts') instanceof Map))
        return false;
    return Object.keys(COLLECTIONS).every((key) => {
        const map = property(value, key);
        return map === undefined || map instanceof Map && [...map].every(([entryKey, text]) => typeof entryKey === 'string' && typeof text === 'string');
    });
}
/** 每个集合怎么切行：array 按元素 id，object 按外层键。 */
export const COLLECTIONS = {
    posts: 'array',
    comments: 'object',
    claims: 'object',
    reactions: 'object',
    notifications: 'array',
    asks: 'array',
    tasks: 'array',
    follows: 'object',
    blocks: 'object',
    reports: 'array',
    patrols: 'array',
    pairings: 'array',
    ratings: 'array',
    proposals: 'array',
};
function isCollection(value) { return Object.hasOwn(COLLECTIONS, value); }
/** 顶层标量字段（version / updatedAt / seeded / tasksSeeded）存在 meta 表。 */
export const META_KEYS = ['version', 'updatedAt', 'seeded', 'tasksSeeded'];
const SCHEMA = `
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS entities (
  collection TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, key)
);
CREATE TABLE IF NOT EXISTS owners (
  token_hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  owner_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS owners_by_id ON owners (owner_id);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;
export function openStore(file) {
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);
    return db;
}
export function meta(db, key, fallback = null) {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key);
    return row ? row.v : fallback;
}
export function setMeta(db, key, value) {
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(value));
}
/** 少数集合的主键不叫 id（配对码用 code，巡检记录只有时间）。 */
const KEY_OF = {
    pairings: (item) => property(item, 'code'),
    patrols: (item) => property(item, 'at'),
};
/** 把集合按行拆开：返回 Map<key, 序列化后的 data>。 */
export function rowsOf(collection, value, kind) {
    const rows = new Map();
    if (kind === 'array') {
        for (const item of Array.isArray(value) ? value : []) {
            const getKey = KEY_OF[collection];
            const key = getKey ? getKey(item) : (item && property(item, 'id'));
            if (key)
                rows.set(String(key), stringify(item));
        }
        return rows;
    }
    for (const [key, entry] of entries(value || {})) {
        rows.set(String(key), stringify(entry));
    }
    return rows;
}
/** 读回来，重建和 feed.json 一样的对象。 */
export function loadState(db) {
    const feed = { version: 1 };
    for (const [collection, kind] of Object.entries(COLLECTIONS)) {
        const rows = db.prepare('SELECT key, data FROM entities WHERE collection = ? ORDER BY rowid').all(collection);
        if (kind === 'array') {
            feed[collection] = rows.map((row) => parseJson(textColumn(row, 'data')));
        }
        else {
            const bag = {};
            for (const row of rows)
                bag[textColumn(row, 'key')] = parseJson(textColumn(row, 'data'));
            feed[collection] = bag;
        }
    }
    for (const key of META_KEYS) {
        const raw = meta(db, 'feed.' + key);
        if (raw === null)
            continue;
        try {
            feed[key] = parseJson(String(raw));
        }
        catch (error) {
            feed[key] = raw;
        }
    }
    const owners = {};
    for (const row of db.prepare('SELECT token_hash, data FROM owners').all()) {
        owners[textColumn(row, 'token_hash')] = parseJson(textColumn(row, 'data'));
    }
    return { feed, owners };
}
/**
 * 把整份状态压成"集合 → Map<key, JSON 串>"。
 * diff 必须拿**字符串快照**做基准：只存引用的话，对象被就地修改后
 * 两边指向同一个对象，差异永远看不出来。
 */
export function buildRows(state) {
    const rows = {};
    for (const [collection, kind] of Object.entries(COLLECTIONS)) {
        if (isCollection(collection))
            rows[collection] = rowsOf(collection, property(state, collection), kind);
    }
    return rows;
}
/** 只写变化的行，删掉消失的行。整批一个事务。 */
export function saveState(db, previous, next) {
    const now = new Date().toISOString();
    const before = isRowsSnapshot(previous) ? previous : buildRows(previous);
    const upsert = db.prepare('INSERT INTO entities (collection, key, data, updated_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(collection, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
    const remove = db.prepare('DELETE FROM entities WHERE collection = ? AND key = ?');
    let written = 0;
    let deleted = 0;
    db.exec('BEGIN');
    try {
        for (const [collection, kind] of Object.entries(COLLECTIONS)) {
            if (!isCollection(collection))
                continue;
            const priorRows = before[collection] || new Map();
            const after = rowsOf(collection, property(next, collection), kind);
            for (const [key, data] of after) {
                if (priorRows.get(key) !== data) {
                    upsert.run(collection, key, data, now);
                    written += 1;
                }
            }
            for (const key of priorRows.keys()) {
                if (!after.has(key)) {
                    remove.run(collection, key);
                    deleted += 1;
                }
            }
        }
        for (const key of META_KEYS) {
            const value = property(next, key);
            if (next && value !== undefined)
                setMeta(db, 'feed.' + key, stringify(value));
        }
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    return { written, deleted };
}
export function saveOwners(db, previous, next) {
    const now = new Date().toISOString();
    const upsert = db.prepare('INSERT INTO owners (token_hash, data, owner_id) VALUES (?, ?, ?) '
        + 'ON CONFLICT(token_hash) DO UPDATE SET data = excluded.data, owner_id = excluded.owner_id');
    const remove = db.prepare('DELETE FROM owners WHERE token_hash = ?');
    let written = 0;
    let deleted = 0;
    db.exec('BEGIN');
    try {
        for (const [hash, owner] of entries(next || {})) {
            const data = stringify(owner);
            if (!previous || JSON.stringify(property(previous, hash)) !== data) {
                upsert.run(hash, data, String(owner && property(owner, 'id') ? property(owner, 'id') : ''));
                written += 1;
            }
        }
        for (const [hash] of entries(previous || {})) {
            if (!Reflect.has(Object(next || {}), hash)) {
                remove.run(hash);
                deleted += 1;
            }
        }
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    return { written, deleted };
}
/** 只读主人表（CLI 加人之后，服务端靠它刷新缓存）。 */
export function loadOwners(db) {
    const owners = {};
    for (const row of db.prepare('SELECT token_hash, data FROM owners').all()) {
        owners[textColumn(row, 'token_hash')] = parseJson(textColumn(row, 'data'));
    }
    return owners;
}
/** 库是不是空的（决定要不要从旧的 JSON 导入一次）。 */
export function isEmpty(db) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM entities').get();
    const owners = db.prepare('SELECT COUNT(*) AS n FROM owners').get();
    return (row?.n === 0) && (owners?.n === 0);
}
export function stats(db) {
    const rows = db.prepare('SELECT collection, COUNT(*) AS n FROM entities GROUP BY collection').all();
    const owners = db.prepare('SELECT COUNT(*) AS n FROM owners').get();
    const page = db.prepare('PRAGMA page_count').get();
    const size = db.prepare('PRAGMA page_size').get();
    const bytes = (page ? Number(page.page_count) : 0) * (size ? Number(size.page_size) : 0);
    const byCollection = {};
    for (const row of rows)
        byCollection[textColumn(row, 'collection')] = Number(row.n);
    return { rows: byCollection, owners: Number(owners?.n), bytes };
}
