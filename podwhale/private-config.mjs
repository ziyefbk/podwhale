import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
function invalid() {
    return Object.assign(new Error('Invalid local configuration'), { code: 'XLB_LOCAL_CONFIG_INVALID' });
}
function configuredPath(value) {
    if (value === undefined || value === '')
        return null;
    if (typeof value !== 'string')
        throw invalid();
    return resolve(value);
}
function samePath(left, right) {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
async function readObject(file, missingAllowed) {
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        if (missingAllowed && error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return null;
        throw invalid();
    }
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw invalid();
        return value;
    }
    catch {
        throw invalid();
    }
}
/** Read deployment settings without silently changing the selected file. */
export async function readLocalConfig({ packageDir, env = process.env }) {
    let primary = '';
    let legacy = '';
    let explicit;
    try {
        const first = configuredPath(env.XLB_LOCAL_CONFIG);
        const second = configuredPath(env.XLB_CONFIG_FILE);
        if (first && second && !samePath(first, second))
            throw invalid();
        explicit = first || second;
        if (!explicit) {
            if (typeof packageDir !== 'string' || !packageDir)
                throw invalid();
            const directory = resolve(packageDir);
            primary = join(directory, 'local.json');
            legacy = join(dirname(directory), 'xiaolanshu', 'local.json');
        }
    }
    catch {
        throw invalid();
    }
    if (explicit)
        return (await readObject(explicit, false));
    const current = await readObject(primary, true);
    if (current)
        return current;
    if (!samePath(primary, legacy)) {
        const previous = await readObject(legacy, true);
        if (previous)
            return previous;
    }
    return {};
}
