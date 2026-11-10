import pino, { Logger as PinoLogger, LoggerOptions as PinoLoggerOptions } from 'pino';
import {
    createDiscordWebhookClient,
    type DiscordDeliveryResult,
    type DiscordEmbedMessage,
    type DiscordSendOptions,
    type DiscordWebhookClient,
} from './webhooks';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface DiscordLoggerConfig {
    /** Discord webhook URL - required for Discord logging */
    webhookUrl?: string;
    /** Timezone for timestamps (default: 'UTC') */
    timezone?: string;
    /** Locale for date formatting (default: 'en-US') */
    locale?: string;
    /** Enable debug mode - logs debug messages (default: false) */
    debug?: boolean;
    /** Enable colored console output (default: true in development) */
    colors?: boolean;
    /** Custom pino options */
    pinoOptions?: PinoLoggerOptions;
    /** Application name to show in logs */
    appName?: string;
    /** Disable Discord logging entirely (useful for testing) */
    disableDiscord?: boolean;
    /** Disable console logging entirely */
    disableConsole?: boolean;
    /**
     * Named webhooks, one per Discord channel (e.g. `{ sales: ..., alerts: ... }`).
     * Channels without a URL fall back to `webhookUrl`.
     */
    webhooks?: Record<string, string | undefined>;
    /** Routes plain log levels to a named webhook, e.g. `{ error: 'alerts', warn: 'alerts' }`. */
    levelChannels?: Partial<Record<LogLevel, string>>;
    /** Footer added to embeds sent through `notify()` (e.g. the environment name). */
    embedFooter?: string;
}

export type LogLevel = 'info' | 'error' | 'warn' | 'debug';

export interface EventData {
    event: string;
    timestamp?: string | Date;
    [key: string]: unknown;
}

// ============================================================================
// Color Configuration
// ============================================================================

const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',

    // Foreground colors
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',

    // Background colors
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
} as const;

const LEVEL_COLORS = {
    info: COLORS.cyan,
    error: COLORS.red,
    warn: COLORS.yellow,
    debug: COLORS.magenta,
} as const;

const LEVEL_ICONS = {
    info: 'ℹ️',
    error: '❌',
    warn: '⚠️',
    debug: '🔍',
} as const;

// ============================================================================
// Discord Logger Class
// ============================================================================

class DiscordLogger {
    private config: Required<Omit<DiscordLoggerConfig, 'webhookUrl' | 'pinoOptions' | 'webhooks' | 'levelChannels' | 'embedFooter'>> & {
        webhookUrl?: string;
        pinoOptions?: PinoLoggerOptions;
        webhooks?: Record<string, string | undefined>;
        levelChannels?: Partial<Record<LogLevel, string>>;
        embedFooter?: string;
    };
    private webhookClient: DiscordWebhookClient;
    private pino: PinoLogger;
    private isServer: boolean = typeof globalThis !== 'undefined' && typeof (globalThis as any).window === 'undefined';
    private initialized: boolean = false;

    constructor() {
        // Default configuration
        this.config = {
            webhookUrl: undefined,
            timezone: 'UTC',
            locale: 'en-US',
            debug: false,
            colors: process.env.NODE_ENV === 'development',
            appName: 'app',
            disableDiscord: false,
            disableConsole: false,
        };

        // Initialize pino with default settings
        this.pino = this.createPinoLogger();
        this.webhookClient = this.createWebhookClient();
    }

    /**
     * Initialize the Discord logger with configuration
     */
    init(config: DiscordLoggerConfig): void {
        this.config = {
            ...this.config,
            ...config,
        };

        // Recreate pino logger with new settings
        this.pino = this.createPinoLogger();
        this.webhookClient = this.createWebhookClient();
        this.initialized = true;

        const hasAnyWebhook = Boolean(this.config.webhookUrl) || Object.values(this.config.webhooks ?? {}).some(Boolean);
        if (!hasAnyWebhook && !this.config.disableDiscord) {
            this.pino.warn('Discord webhook URL not provided - Discord logging disabled');
        }
    }

    private get isNextRuntime(): boolean {
        const proc = typeof globalThis !== 'undefined' && typeof (globalThis as any).process !== 'undefined'
            ? (globalThis as any).process
            : undefined;
        return !!process.env.NEXT_PUBLIC_ || !!process.env.NEXT_RUNTIME || !!(proc && proc.argv && proc.argv.join(' ').includes('next'));
    }

    private createPinoLogger(): PinoLogger {
        const isDev = process.env.NODE_ENV === 'development';
        // pino-pretty runs in a worker thread, which Next.js bundling breaks.
        const runningInNext = this.isNextRuntime;

        const baseOptions: PinoLoggerOptions = {
            level: this.config.debug ? 'debug' : 'info',
            ...(this.config.pinoOptions || {}),
        };

        // Use pino-pretty in development for colored output
        if (isDev && this.config.colors && !this.config.disableConsole && !runningInNext) {
            try {
                // pino-pretty is optional: fall back to plain JSON output when it is not installed.
                require('pino-pretty');
                return pino({
                    ...baseOptions,
                    transport: {
                        target: 'pino-pretty',
                        options: {
                            colorize: true,
                            translateTime: `SYS:standard`,
                            ignore: 'pid,hostname',
                        },
                    },
                });
            } catch {
                return pino(baseOptions);
            }
        }

        return pino(baseOptions);
    }

    // ========================================================================
    // Formatting Helpers
    // ========================================================================

    private formatTimestamp(): string {
        return new Date().toLocaleString(this.config.locale, {
            timeZone: this.config.timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    private formatMessage(message: unknown): string {
        if (typeof message === 'string') {
            return message;
        }

        // Special formatting for event objects
        if (message && typeof message === 'object' && 'event' in message) {
            return this.formatEventMessage(message as EventData);
        }

        return '```json\n' + JSON.stringify(message, null, 2) + '\n```';
    }

    private formatEventMessage(eventData: EventData): string {
        const { event, timestamp, ...data } = eventData;

        // Format timestamp
        const time = timestamp
            ? new Date(timestamp as string | Date).toLocaleString(this.config.locale, {
                timeZone: this.config.timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            })
            : this.formatTimestamp();

        let formatted = `**${event.toUpperCase()}** - ${time}\n`;

        // Format key data points based on event type
        const keyInfo = this.extractKeyInfo(event, data);
        if (keyInfo.length > 0) {
            formatted += keyInfo.join(' • ') + '\n';
        }

        // Add additional details if not too long
        const additionalData = this.getAdditionalDetails(data, keyInfo);
        if (additionalData && formatted.length + additionalData.length < 1800) {
            formatted += '\n' + additionalData;
        }

        return formatted;
    }

    private extractKeyInfo(event: string, data: Record<string, unknown>): string[] {
        const info: string[] = [];

        // Common fields
        if (data.userId) info.push(`User: ${data.userId}`);
        if (data.email) info.push(`Email: ${data.email}`);
        if (data.name) info.push(`Name: ${data.name}`);

        // Event-specific fields
        const eventLower = event.toLowerCase();

        if (eventLower.includes('user')) {
            if (data.provider) info.push(`Provider: ${data.provider}`);
        }

        if (eventLower.includes('payment') || eventLower.includes('credit')) {
            if (data.amount) info.push(`$${data.amount}`);
            if (data.credits) info.push(`${data.credits} credits`);
            if (data.paymentId) info.push(`ID: ${data.paymentId}`);
        }

        if (eventLower.includes('job')) {
            if (data.jobId) info.push(`Job: ${data.jobId}`);
            if (data.title) info.push(`"${data.title}"`);
            if (data.company) info.push(`@${data.company}`);
        }

        if (eventLower.includes('application')) {
            if (data.applicationId) info.push(`App: ${data.applicationId}`);
            if (data.jobId) info.push(`Job: ${data.jobId}`);
            if (data.oldStatus && data.newStatus) {
                info.push(`${data.oldStatus} → ${data.newStatus}`);
            }
        }

        if (eventLower.includes('api_key') || eventLower.includes('apikey')) {
            if (data.apiKeyName) info.push(`"${data.apiKeyName}"`);
        }

        if (eventLower.includes('webhook')) {
            if (data.webhookName) info.push(`"${data.webhookName}"`);
            if (Array.isArray(data.events)) info.push(`${data.events.length} events`);
        }

        return info;
    }

    private getAdditionalDetails(data: Record<string, unknown>, excludeKeys: string[]): string | null {
        const importantKeys = ['location', 'salary', 'status', 'method', 'error', 'url', 'ip', 'userAgent'];
        const details: string[] = [];

        for (const key of importantKeys) {
            if (data[key] && !excludeKeys.some((info) => info.includes(String(data[key])))) {
                details.push(`**${key}:** ${data[key]}`);
            }
        }

        return details.length > 0 ? details.join('\n') : null;
    }

    // ========================================================================
    // Discord Integration
    // ========================================================================

    private createWebhookClient(): DiscordWebhookClient {
        return createDiscordWebhookClient({
            webhooks: this.config.webhooks,
            fallbackWebhookUrl: this.config.webhookUrl,
            footer: this.config.embedFooter,
            onFailure: (failure) => this.pino.warn({ discord: failure }, 'Failed to send message to Discord'),
        });
    }

    /** Webhook for a plain log level: its routed channel if configured, else the default webhook. */
    private webhookForLevel(level: LogLevel): string | undefined {
        const channel = this.config.levelChannels?.[level];
        return (channel && this.webhookClient.resolveWebhookUrl(channel)) || this.config.webhookUrl;
    }

    private async sendToDiscord(content: string, level: keyof typeof LEVEL_ICONS): Promise<void> {
        const webhookUrl = this.webhookForLevel(level);
        // Skip if not enabled or not in server environment
        if (!this.isServer || this.config.disableDiscord || !webhookUrl) {
            return;
        }

        try {
            const icon = LEVEL_ICONS[level];
            const prefix = this.config.appName ? `[${this.config.appName}] ` : '';
            const fullContent = `${icon} ${prefix}${content}`.substring(0, 2000);

            await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: fullContent }),
            });
        } catch (error) {
            this.pino.error({ error }, 'Failed to send message to Discord');
        }
    }

    // ========================================================================
    // Console Output with Colors
    // ========================================================================

    private consoleLog(level: keyof typeof LEVEL_COLORS, message: string, data?: unknown): void {
        if (this.config.disableConsole) return;

        const timestamp = this.formatTimestamp();
        const color = this.config.colors ? LEVEL_COLORS[level] : '';
        const reset = this.config.colors ? COLORS.reset : '';
        const dim = this.config.colors ? COLORS.dim : '';
        const appPrefix = this.config.appName ? `[${this.config.appName}] ` : '';

        const formattedMessage = `${dim}${timestamp}${reset} ${color}${level.toUpperCase().padEnd(5)}${reset} ${appPrefix}${message}`;

        if (data) {
            console.log(formattedMessage, data);
        } else {
            console.log(formattedMessage);
        }
    }

    // ========================================================================
    // Public Logging Methods
    // ========================================================================

    /**
     * Log an info message
     */
    info(message: unknown, data?: Record<string, unknown>): void {
        const formatted = this.formatMessage(message);

        // Pino logging
        if (data) {
            this.pino.info(data, typeof message === 'string' ? message : 'info');
        } else {
            this.pino.info(typeof message === 'string' ? message : { data: message });
        }

        // Discord logging (async, fire and forget)
        this.sendToDiscord(formatted, 'info').catch(() => { });
    }

    /**
     * Log an error message with optional error object
     */
    error(message: string, error?: Error | unknown): void {
        const timestamp = this.formatTimestamp();
        let formattedMessage = `**ERROR** - ${timestamp}\n**${message}**\n`;

        // Pino logging
        if (error instanceof Error) {
            this.pino.error({ err: error }, message);
            formattedMessage += `\n**Message:** ${error.message}`;
            if (error.stack) {
                formattedMessage += '\n```\n' + error.stack.substring(0, 1000) + '\n```';
            }
        } else if (error && typeof error === 'object') {
            this.pino.error({ error }, message);
            formattedMessage += '\n```json\n' + JSON.stringify(error, null, 2).substring(0, 1000) + '\n```';
        } else if (error) {
            this.pino.error({ error }, message);
            formattedMessage += `\n**Details:** ${error}`;
        } else {
            this.pino.error(message);
        }

        // Discord logging (async, fire and forget)
        this.sendToDiscord(formattedMessage, 'error').catch(() => { });
    }

    /**
     * Log a warning message
     */
    warn(message: unknown, data?: Record<string, unknown>): void {
        const timestamp = this.formatTimestamp();
        let formatted: string;

        if (typeof message === 'string') {
            formatted = `**WARNING** - ${timestamp}\n${message}`;
            if (data) {
                this.pino.warn(data, message);
            } else {
                this.pino.warn(message);
            }
        } else {
            formatted = `**WARNING**\n${this.formatMessage(message)}`;
            this.pino.warn(message as object);
        }

        // Discord logging (async, fire and forget)
        this.sendToDiscord(formatted, 'warn').catch(() => { });
    }

    /**
     * Log a debug message (only in debug mode)
     */
    debug(message: unknown, data?: Record<string, unknown>): void {
        if (!this.config.debug) return;

        const timestamp = this.formatTimestamp();
        const formatted = `**DEBUG** - ${timestamp}\n${this.formatMessage(message)}`;

        // Pino logging
        if (data) {
            this.pino.debug(data, typeof message === 'string' ? message : 'debug');
        } else {
            this.pino.debug(typeof message === 'string' ? message : { data: message });
        }

        // Discord logging (async, fire and forget)
        this.sendToDiscord(formatted, 'debug').catch(() => { });
    }

    /**
     * Create a child logger with additional context
     */
    child(bindings: Record<string, unknown>): {
        info: (message: unknown, data?: Record<string, unknown>) => void;
        error: (message: string, error?: Error | unknown) => void;
        warn: (message: unknown, data?: Record<string, unknown>) => void;
        debug: (message: unknown, data?: Record<string, unknown>) => void;
    } {
        const childPino = this.pino.child(bindings);
        const self = this;

        return {
            info(message: unknown, data?: Record<string, unknown>): void {
                const formatted = self.formatMessage(message);
                if (data) {
                    childPino.info(data, typeof message === 'string' ? message : 'info');
                } else {
                    childPino.info(typeof message === 'string' ? message : { data: message });
                }
                self.sendToDiscord(`[${JSON.stringify(bindings)}] ${formatted}`, 'info').catch(() => { });
            },
            error(message: string, error?: Error | unknown): void {
                if (error instanceof Error) {
                    childPino.error({ err: error }, message);
                } else {
                    childPino.error({ error }, message);
                }
                self.sendToDiscord(`[${JSON.stringify(bindings)}] ${message}`, 'error').catch(() => { });
            },
            warn(message: unknown, data?: Record<string, unknown>): void {
                if (data) {
                    childPino.warn(data, typeof message === 'string' ? message : 'warn');
                } else {
                    childPino.warn(typeof message === 'string' ? message : { data: message });
                }
                self.sendToDiscord(`[${JSON.stringify(bindings)}] ${self.formatMessage(message)}`, 'warn').catch(() => { });
            },
            debug(message: unknown, data?: Record<string, unknown>): void {
                if (!self.config.debug) return;
                if (data) {
                    childPino.debug(data, typeof message === 'string' ? message : 'debug');
                } else {
                    childPino.debug(typeof message === 'string' ? message : { data: message });
                }
                self.sendToDiscord(`[${JSON.stringify(bindings)}] ${self.formatMessage(message)}`, 'debug').catch(() => { });
            },
        };
    }

    /**
     * Get the underlying pino logger instance
     */
    getPino(): PinoLogger {
        return this.pino;
    }

    /**
     * Send a rich embed to a named webhook (see `webhooks`). Never throws; mentions are
     * disabled unless `mention: true`. Use `wait: true` to get a message id for `edit()`.
     */
    async notify(message: DiscordEmbedMessage, options?: DiscordSendOptions): Promise<DiscordDeliveryResult> {
        if (!this.isServer || this.config.disableDiscord) return { ok: false };
        return this.webhookClient.send(message, options);
    }

    /**
     * Edit an embed previously sent with `notify(message, { wait: true })`.
     */
    async edit(messageId: string, message: DiscordEmbedMessage): Promise<DiscordDeliveryResult> {
        if (!this.isServer || this.config.disableDiscord) return { ok: false };
        return this.webhookClient.edit(messageId, message);
    }

    /**
     * Check if the logger has been initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

const loggerInstance = new DiscordLogger();

/**
 * Initialize the Discord logger with your configuration.
 * Call this once at app startup (e.g., in instrumentation.ts for Next.js)
 * 
 * @example
 * ```typescript
 * import { initDiscordLogger } from '@c5h/discord-logger';
 * 
 * initDiscordLogger({
 *   webhookUrl: process.env.DISCORD_WEBHOOK_URL,
 *   timezone: 'America/Argentina/Buenos_Aires',
 *   locale: 'es-AR',
 *   appName: 'my-app',
 *   debug: process.env.NODE_ENV === 'development',
 * });
 * ```
 */
export function initDiscordLogger(config: DiscordLoggerConfig): void {
    loggerInstance.init(config);
}

/**
 * The logger instance. Use this to log messages.
 * Make sure to call `initDiscordLogger()` before using.
 * 
 * @example
 * ```typescript
 * import { log } from '@c5h/discord-logger';
 * 
 * log.info('User logged in');
 * log.error('Something went wrong', new Error('Oops'));
 * log.warn('Deprecated function called');
 * log.debug('Debug info', { userId: 123 });
 * ```
 */
export const log = loggerInstance;

/**
 * Create a new independent logger instance (not recommended, use singleton)
 */
export function createLogger(config?: DiscordLoggerConfig): DiscordLogger {
    const logger = new DiscordLogger();
    if (config) {
        logger.init(config);
    }
    return logger;
}

// Re-export types
export type { PinoLogger, PinoLoggerOptions };
export * from './webhooks';
