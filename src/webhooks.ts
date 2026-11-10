// ============================================================================
// Multi-channel Discord webhooks: embeds, routing, rate limits, edits, dedupe
// ============================================================================

export interface DiscordEmbedField {
    name: string;
    value: string;
    inline?: boolean;
}

export interface DiscordEmbedMessage<C extends string = string> {
    /** Logical channel name, resolved to a webhook URL by the client. */
    channel: C;
    title: string;
    description?: string;
    color?: number;
    url?: string;
    /** Falsy entries and blank values are dropped, so fields can be built conditionally. */
    fields?: Array<DiscordEmbedField | null | undefined | false>;
    /** Adds an explicit @here ping. Everything else is sent with mentions disabled. */
    mention?: boolean;
    timestamp?: string;
    footer?: string;
}

export interface DiscordWebhookPayload {
    content?: string;
    embeds: Array<Record<string, unknown>>;
    allowed_mentions: { parse: string[] };
}

const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, footer: 2048, total: 6000 };
const DEFAULT_COLOR = 0x2563eb;

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Neutralizes mention syntax inside user-controlled text even though embeds never ping. */
function neutralize(value: string): string {
    return value.replace(/@(everyone|here)/gi, '@​$1').replace(/<@[!&]?(\d+)>/g, '<@​$1>');
}

/** Builds a webhook body that respects Discord's embed limits and never pings unless asked to. */
export function buildDiscordPayload(message: DiscordEmbedMessage, options: { footer?: string } = {}): DiscordWebhookPayload {
    const fields = (message.fields ?? [])
        .filter((field): field is DiscordEmbedField => Boolean(field && field.name && field.value?.trim()))
        .slice(0, LIMITS.fields)
        .map((field) => ({
            name: truncate(neutralize(field.name), LIMITS.fieldName),
            value: truncate(neutralize(field.value), LIMITS.fieldValue),
            inline: field.inline ?? true,
        }));

    const embed: Record<string, unknown> = {
        title: truncate(neutralize(message.title), LIMITS.title),
        color: message.color ?? DEFAULT_COLOR,
        timestamp: message.timestamp ?? new Date().toISOString(),
    };
    if (message.description) embed.description = truncate(neutralize(message.description), LIMITS.description);
    if (message.url && /^https?:\/\//.test(message.url)) embed.url = message.url;
    if (fields.length) embed.fields = fields;
    const footer = message.footer ?? options.footer;
    if (footer) embed.footer = { text: truncate(footer, LIMITS.footer) };

    // Discord rejects embeds above 6000 characters overall; drop trailing fields until it fits.
    const size = () => JSON.stringify([embed.title, embed.description, embed.fields, embed.footer]).length;
    while (size() > LIMITS.total && Array.isArray(embed.fields) && embed.fields.length) {
        (embed.fields as unknown[]).pop();
    }

    return {
        ...(message.mention ? { content: '@here' } : {}),
        embeds: [embed],
        allowed_mentions: { parse: message.mention ? ['everyone'] : [] },
    };
}

/** Field helper: returns null for empty values so it can be used inline in `fields`. */
export function field(name: string, value: unknown, inline = true): DiscordEmbedField | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? { name, value: text, inline } : null;
}

// ----------------------------------------------------------------------------
// Client
// ----------------------------------------------------------------------------

export interface DiscordDeliveryResult {
    ok: boolean;
    /** Present when sent with `wait: true`; needed to edit the message later. */
    messageId?: string;
    status?: number;
    errorName?: string;
}

export interface DiscordDeliveryFailure<C extends string = string> {
    channel: C;
    title: string;
    status?: number;
    errorName?: string;
}

export interface DiscordWebhookClientOptions<C extends string = string> {
    /** Static channel → webhook URL map. Blank values count as missing. */
    webhooks?: Partial<Record<C, string | undefined>>;
    /**
     * Dynamic resolver, called on every send (e.g. to read process.env lazily).
     * Takes precedence over `webhooks`.
     */
    resolveWebhookUrl?: (channel: C) => string | undefined;
    /** Used for any channel without its own webhook, so partial config never drops messages. */
    fallbackWebhookUrl?: string | (() => string | undefined);
    /** Default embed footer (e.g. environment name). */
    footer?: string | (() => string | undefined);
    /** Per-request timeout (default 5000ms). */
    timeoutMs?: number;
    /** Upper bound for honoring a 429 `retry_after` before the single retry (default 10000ms). */
    maxRetryAfterMs?: number;
    onFailure?: (failure: DiscordDeliveryFailure<C>) => void;
    /** Custom fetch implementation. Defaults to the global fetch at call time. */
    fetch?: typeof fetch;
}

export interface DiscordSendOptions {
    /** Wait for Discord and return the message id (needed to edit it later). */
    wait?: boolean;
    timeoutMs?: number;
}

export interface DiscordWebhookClient<C extends string = string> {
    resolveWebhookUrl(channel: C): string | undefined;
    send(message: DiscordEmbedMessage<C>, options?: DiscordSendOptions): Promise<DiscordDeliveryResult>;
    /** Edits a message previously sent with `wait: true` on the same channel. */
    edit(messageId: string, message: DiscordEmbedMessage<C>, options?: Pick<DiscordSendOptions, 'timeoutMs'>): Promise<DiscordDeliveryResult>;
    /** Replaces the failure listener. */
    onFailure(listener: ((failure: DiscordDeliveryFailure<C>) => void) | undefined): void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;

function resolveValue(value: string | (() => string | undefined) | undefined): string | undefined {
    return (typeof value === 'function' ? value() : value)?.trim() || undefined;
}

/**
 * Creates a client that routes embeds to one webhook per logical channel.
 * Requests are serialized per webhook to stay under Discord's burst limit,
 * 429s are retried once, and failures are reported instead of thrown.
 */
export function createDiscordWebhookClient<C extends string = string>(
    options: DiscordWebhookClientOptions<C> = {},
): DiscordWebhookClient<C> {
    const queues = new Map<string, Promise<unknown>>();
    let failureListener = options.onFailure;
    const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

    function resolveWebhookUrl(channel: C): string | undefined {
        const specific = options.resolveWebhookUrl ? options.resolveWebhookUrl(channel) : options.webhooks?.[channel];
        return specific?.trim() || resolveValue(options.fallbackWebhookUrl);
    }

    function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(task);
        queues.set(key, next);
        void next.finally(() => {
            if (queues.get(key) === next) queues.delete(key);
        });
        return next;
    }

    async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        const doFetch = options.fetch ?? globalThis.fetch;
        let response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 429) {
            const body = await response.json().catch(() => ({})) as { retry_after?: number };
            const retryAfterMs = Math.min(maxRetryAfterMs, Math.max(250, Number(body.retry_after ?? 1) * 1000));
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        }
        return response;
    }

    async function deliver(
        message: DiscordEmbedMessage<C>,
        url: string,
        init: RequestInit,
        wait: boolean,
        timeoutMs: number,
    ): Promise<DiscordDeliveryResult> {
        try {
            const response = await request(url, init, timeoutMs);
            if (!response.ok) {
                failureListener?.({ channel: message.channel, status: response.status, title: message.title });
                return { ok: false, status: response.status };
            }
            if (!wait) return { ok: true, status: response.status };
            const body = await response.json().catch(() => null) as { id?: string } | null;
            return { ok: true, status: response.status, messageId: body?.id };
        } catch (error) {
            const errorName = error instanceof Error ? error.name : 'UnknownError';
            failureListener?.({ channel: message.channel, errorName, title: message.title });
            return { ok: false, errorName };
        }
    }

    return {
        resolveWebhookUrl,

        async send(message, sendOptions = {}) {
            const webhookUrl = resolveWebhookUrl(message.channel);
            if (!webhookUrl) return { ok: false };
            const url = sendOptions.wait ? `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true` : webhookUrl;
            const body = JSON.stringify(buildDiscordPayload(message, { footer: resolveValue(options.footer) }));
            return enqueue(webhookUrl, () => deliver(message, url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            }, Boolean(sendOptions.wait), sendOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
        },

        async edit(messageId, message, editOptions = {}) {
            const webhookUrl = resolveWebhookUrl(message.channel);
            if (!webhookUrl || !/^\d+$/.test(messageId)) return { ok: false };
            const [base, query] = webhookUrl.split('?');
            const url = `${base.replace(/\/+$/, '')}/messages/${messageId}${query ? `?${query}` : ''}`;
            const payload = buildDiscordPayload({ ...message, mention: false }, { footer: resolveValue(options.footer) });
            return enqueue(webhookUrl, () => deliver(message, url, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: payload.embeds, allowed_mentions: payload.allowed_mentions }),
            }, false, editOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
        },

        onFailure(listener) {
            failureListener = listener;
        },
    };
}

// ----------------------------------------------------------------------------
// Alert deduplication
// ----------------------------------------------------------------------------

export interface AlertDeduper {
    /** `send: false` while the fingerprint is inside its window; `suppressed` counts the repeats. */
    check(fingerprint: string): { send: boolean; suppressed: number };
}

/**
 * In-process deduplication: the same fingerprint is delivered at most once per window.
 * Repeats inside the window are counted and reported on the next delivered occurrence.
 */
export function createAlertDeduper(options: { windowMs?: number; maxKeys?: number; now?: () => number } = {}): AlertDeduper {
    const windowMs = options.windowMs ?? 10 * 60_000;
    const maxKeys = options.maxKeys ?? 500;
    const now = options.now ?? Date.now;
    const entries = new Map<string, { sentAt: number; suppressed: number }>();

    return {
        check(fingerprint) {
            const at = now();
            const entry = entries.get(fingerprint);
            if (entry && at - entry.sentAt < windowMs) {
                entry.suppressed += 1;
                return { send: false, suppressed: entry.suppressed };
            }
            const suppressed = entry?.suppressed ?? 0;
            entries.delete(fingerprint);
            entries.set(fingerprint, { sentAt: at, suppressed: 0 });
            if (entries.size > maxKeys) entries.delete(entries.keys().next().value as string);
            return { send: true, suppressed };
        },
    };
}

/** Collapses ids, numbers and hashes so "timeout for job 123" and "job 456" share a fingerprint. */
export function alertFingerprint(...parts: unknown[]): string {
    return parts
        .map((part) => String(part ?? ''))
        .join('|')
        .toLowerCase()
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<uuid>')
        .replace(/\b[a-z0-9_-]{21}\b/g, '<id>')
        .replace(/\d+/g, '<n>')
        .slice(0, 300);
}
