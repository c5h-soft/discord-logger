import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertFingerprint, buildDiscordPayload, createAlertDeduper, createDiscordWebhookClient, createLogger, field } from '../src/index';

type Call = { url: string; init: RequestInit; body?: any };

function fakeFetch(responses: Response[] = []) {
    const calls: Call[] = [];
    const impl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
        calls.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return responses.shift() ?? new Response(JSON.stringify({ id: '1234567890' }), { status: 200 });
    });
    return { calls, fetch: impl as unknown as typeof fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe('buildDiscordPayload', () => {
    it('never pings unless asked and neutralizes user mentions', () => {
        const quiet = buildDiscordPayload({ channel: 'growth', title: 'Hi @everyone', fields: [{ name: 'x', value: '<@123> @here' }] });
        expect(quiet.allowed_mentions).toEqual({ parse: [] });
        expect(quiet.content).toBeUndefined();
        expect(JSON.stringify(quiet.embeds)).not.toMatch(/@everyone|@here|<@123>/);

        const loud = buildDiscordPayload({ channel: 'alerts', title: 'Down', mention: true });
        expect(loud.content).toBe('@here');
        expect(loud.allowed_mentions).toEqual({ parse: ['everyone'] });
    });

    it('drops empty fields, truncates and stays under Discord limits', () => {
        const payload = buildDiscordPayload({
            channel: 'sales',
            title: 'x'.repeat(400),
            fields: [null, false, field('empty', '  '), ...Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: 'v'.repeat(1500) }))],
        }, { footer: 'staging' });
        const [embed] = payload.embeds as any[];
        expect(embed.title).toHaveLength(256);
        expect(embed.fields.length).toBeLessThanOrEqual(25);
        expect(embed.fields.every((entry: any) => entry.value.length <= 1024)).toBe(true);
        expect(JSON.stringify([embed.title, embed.fields, embed.footer]).length).toBeLessThanOrEqual(6000);
        expect(embed.footer).toEqual({ text: 'staging' });
    });
});

describe('createDiscordWebhookClient', () => {
    it('routes each channel to its webhook and falls back to the default one', async () => {
        const { calls, fetch } = fakeFetch();
        const client = createDiscordWebhookClient({
            webhooks: { sales: ' https://discord.test/api/webhooks/2/sales ', alerts: '' },
            fallbackWebhookUrl: 'https://discord.test/api/webhooks/1/default',
            fetch,
        });
        expect(await client.send({ channel: 'sales', title: 'Sale' }, { wait: true })).toEqual({ ok: true, status: 200, messageId: '1234567890' });
        expect(calls[0].url).toBe('https://discord.test/api/webhooks/2/sales?wait=true');
        expect(calls[0].body.embeds[0].title).toBe('Sale');

        await client.send({ channel: 'alerts', title: 'x' });
        expect(calls[1].url).toBe('https://discord.test/api/webhooks/1/default');
    });

    it('reads the resolver lazily and uses the global fetch at call time', async () => {
        const { calls, fetch } = fakeFetch();
        vi.stubGlobal('fetch', fetch);
        const env: Record<string, string | undefined> = {};
        const client = createDiscordWebhookClient({ resolveWebhookUrl: (channel) => env[channel] });
        expect(await client.send({ channel: 'sales', title: 'x' })).toEqual({ ok: false });
        env.sales = 'https://discord.test/api/webhooks/2/sales';
        expect((await client.send({ channel: 'sales', title: 'x' })).ok).toBe(true);
        expect(calls).toHaveLength(1);
    });

    it('edits through /messages/:id without pinging and rejects non-numeric ids', async () => {
        const { calls, fetch } = fakeFetch();
        const client = createDiscordWebhookClient({ webhooks: { sales: 'https://discord.test/api/webhooks/2/sales?thread_id=9' }, fetch });
        await client.edit('987', { channel: 'sales', title: 'edited', mention: true });
        expect(calls[0].url).toBe('https://discord.test/api/webhooks/2/sales/messages/987?thread_id=9');
        expect(calls[0].init.method).toBe('PATCH');
        expect(calls[0].body.content).toBeUndefined();
        expect(await client.edit('../evil', { channel: 'sales', title: 'x' })).toEqual({ ok: false });
    });

    it('retries once after a 429 and reports failures without throwing', async () => {
        const failures: unknown[] = [];
        const { calls, fetch } = fakeFetch([new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 })]);
        const client = createDiscordWebhookClient({ fallbackWebhookUrl: 'https://discord.test/api/webhooks/1/x', fetch, onFailure: (f) => failures.push(f) });
        expect((await client.send({ channel: 'alerts', title: 'x' })).ok).toBe(true);
        expect(calls).toHaveLength(2);

        const failing = createDiscordWebhookClient({
            fallbackWebhookUrl: 'https://discord.test/api/webhooks/1/x',
            fetch: fakeFetch([new Response('nope', { status: 500 })]).fetch,
            onFailure: (f) => failures.push(f),
        });
        expect(await failing.send({ channel: 'alerts', title: 'boom' })).toEqual({ ok: false, status: 500 });
        expect(failures).toEqual([{ channel: 'alerts', status: 500, title: 'boom' }]);
    });

    it('serializes requests per webhook', async () => {
        let active = 0;
        let maxActive = 0;
        const fetch = (async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return new Response(null, { status: 204 });
        }) as unknown as typeof globalThis.fetch;
        const client = createDiscordWebhookClient({ fallbackWebhookUrl: 'https://discord.test/api/webhooks/1/x', fetch });
        await Promise.all([1, 2, 3].map((n) => client.send({ channel: 'a', title: String(n) })));
        expect(maxActive).toBe(1);
    });
});

describe('alert dedupe', () => {
    it('sends once per window and reports suppressed repeats', () => {
        let now = 0;
        const deduper = createAlertDeduper({ windowMs: 1000, now: () => now });
        expect(deduper.check('a')).toEqual({ send: true, suppressed: 0 });
        expect(deduper.check('a')).toEqual({ send: false, suppressed: 1 });
        expect(deduper.check('a')).toEqual({ send: false, suppressed: 2 });
        expect(deduper.check('b')).toEqual({ send: true, suppressed: 0 });
        now = 1500;
        expect(deduper.check('a')).toEqual({ send: true, suppressed: 2 });
        expect(alertFingerprint('error', 'timeout job 123')).toBe(alertFingerprint('error', 'timeout job 456'));
    });
});

describe('DiscordLogger', () => {
    it('keeps the single-webhook behavior and routes levels to named webhooks', async () => {
        const { calls, fetch } = fakeFetch();
        vi.stubGlobal('fetch', fetch);
        const logger = createLogger({
            webhookUrl: 'https://discord.test/api/webhooks/1/default',
            webhooks: { alerts: 'https://discord.test/api/webhooks/3/alerts' },
            levelChannels: { error: 'alerts' },
            disableConsole: true,
            pinoOptions: { level: 'silent' },
        });
        logger.info('hello');
        logger.error('broken', new Error('x'));
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(calls.map((call) => call.url).sort()).toEqual([
            'https://discord.test/api/webhooks/1/default',
            'https://discord.test/api/webhooks/3/alerts',
        ]);

        const result = await logger.notify({ channel: 'alerts', title: 'Embed' }, { wait: true });
        expect(result.messageId).toBe('1234567890');
        expect(calls[2].body.embeds[0].title).toBe('Embed');
    });

    it('does nothing when Discord is disabled', async () => {
        const { calls, fetch } = fakeFetch();
        vi.stubGlobal('fetch', fetch);
        const logger = createLogger({ webhookUrl: 'https://discord.test/x', disableDiscord: true, pinoOptions: { level: 'silent' } });
        logger.error('x');
        expect(await logger.notify({ channel: 'any', title: 'x' })).toEqual({ ok: false });
        expect(calls).toHaveLength(0);
    });
});
