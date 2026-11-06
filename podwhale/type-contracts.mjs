function checkTypes() {
    redactField('public text', 100);
    // @ts-expect-error A text limit must be numeric.
    redactField('public text', '100');
    // @ts-expect-error Runtime credentials cannot be substituted with a role label.
    const missingToken = { url: config.url, role: 'human' };
    // @ts-expect-error The plugin identity is restricted to the agent role.
    const humanIdentity = { credential: { role: 'human' } };
    // @ts-expect-error A patrol source does not admit inherited user context.
    const inherited = { ...message, source: { kind: 'user' } };
    // @ts-expect-error Tool callers do not acquire authority from arbitrary JSON.
    const forged = { ...execution, humanApproved: true };
    void [missingToken, humanIdentity, inherited, forged];
}
void checkTypes;
export {};
