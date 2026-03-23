import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

/** Parse a Slack JID into channelId and optional threadTs. */
function parseSlackJid(jid: string): { channelId: string; threadTs?: string } {
  const stripped = jid.replace(/^slack:/, '');
  const threadMatch = stripped.match(/^(.+?):thread:(.+)$/);
  if (threadMatch) {
    return { channelId: threadMatch[1], threadTs: threadMatch[2] };
  }
  return { channelId: stripped };
}

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private lastMessageTs = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Determine JID: thread replies get their own isolated JID so they
      // have separate context and the agent replies in the thread.
      const threadTs = (msg as GenericMessageEvent).thread_ts;
      const baseJid = `slack:${msg.channel}`;
      const jid = threadTs
        ? `slack:${msg.channel}:thread:${threadTs}`
        : baseJid;

      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for the base channel (for chat discovery)
      this.opts.onChatMetadata(baseJid, timestamp, undefined, 'slack', isGroup);
      // Thread JIDs also need a chats row so messages can reference them (FK constraint)
      if (threadTs) {
        this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);
      }

      // Auto-register channels when bot is @mentioned in an unregistered channel.
      // This lets the bot grow with the Slack workspace — just invite it and @mention.
      const groups = this.opts.registeredGroups();
      if (!groups[baseJid]) {
        const isBotMentioned =
          this.botUserId && msg.text?.includes(`<@${this.botUserId}>`);
        const isDM = msg.channel_type === 'im';
        if (!isBotMentioned && !isDM) return;

        // All Slack channels share the main group's folder so they have
        // unified memory, sessions, and project access — one agent brain.
        const mainGroup = Object.values(this.opts.registeredGroups()).find(
          (g) => g.isMain,
        );
        const mainFolder = mainGroup?.folder || 'slack_main';
        const displayName = isDM
          ? msg.user
            ? await this.resolveUserName(msg.user)
            : undefined
          : await this.resolveChannelName(msg.channel);

        this.opts.registerGroup(baseJid, {
          name: displayName || msg.channel,
          folder: mainFolder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: isDM ? false : true,
          isMain: true,
        });
        logger.info(
          { jid: baseJid, name: displayName, folder: mainFolder, isDM },
          'Auto-registered Slack channel on @mention',
        );
      }

      // Self-heal: DMs should never require a trigger (you can't @mention in a DM).
      // Fix if the group was registered via IPC or other path that didn't set this.
      if (
        msg.channel_type === 'im' &&
        groups[baseJid]?.requiresTrigger !== false
      ) {
        groups[baseJid].requiresTrigger = false;
        this.opts.registerGroup(baseJid, groups[baseJid]); // persist fix to DB
        logger.info(
          { jid: baseJid },
          'Self-healed DM requiresTrigger to false',
        );
      }

      // Auto-register thread JIDs in memory when the base channel is registered.
      // Threads inherit the parent channel's config and require @mention like channels.
      if (threadTs && !groups[jid] && groups[baseJid]) {
        const parent = groups[baseJid];
        // In-memory only — threads are ephemeral, no DB persistence
        groups[jid] = {
          ...parent,
          requiresTrigger: parent.requiresTrigger ?? true,
        };
        logger.debug(
          { jid, baseJid },
          'Auto-registered Slack thread (in-memory)',
        );
      }

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track last user message timestamp for reaction-based typing indicator
      if (!isBotMessage) {
        this.lastMessageTs.set(jid, msg.ts);
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const { channelId, threadTs } = parseSlackJid(jid);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      const baseOpts: { channel: string; text: string; thread_ts?: string } = {
        channel: channelId,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      };

      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage(baseOpts);
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            ...baseOpts,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  /**
   * Simulate typing indicator via emoji reactions.
   * Adds 👀 when processing starts, removes it when done.
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const { channelId } = parseSlackJid(jid);
    const lastTs = this.lastMessageTs.get(jid);
    if (!lastTs) return;

    try {
      if (isTyping) {
        await this.app.client.reactions.add({
          channel: channelId,
          timestamp: lastTs,
          name: 'eyes',
        });
      } else {
        await this.app.client.reactions.remove({
          channel: channelId,
          timestamp: lastTs,
          name: 'eyes',
        });
      }
    } catch (err) {
      logger.debug({ jid, isTyping, err }, 'Reaction typing indicator failed');
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveChannelName(
    channelId: string,
  ): Promise<string | undefined> {
    try {
      const result = await this.app.client.conversations.info({
        channel: channelId,
      });
      return result.channel?.name;
    } catch (err) {
      logger.debug({ channelId, err }, 'Failed to resolve Slack channel name');
      return undefined;
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  /**
   * Fetch the parent message of a thread via Slack API.
   * Used when the parent wasn't stored in our DB (e.g. block-only bot messages
   * with no text field that were filtered out on ingest).
   */
  async fetchThreadParent(
    jid: string,
  ): Promise<import('../types.js').NewMessage | undefined> {
    const { channelId, threadTs } = parseSlackJid(jid);
    if (!threadTs || !this.connected) return undefined;

    try {
      const result = await this.app.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 1,
        inclusive: true,
      });
      const parent = result.messages?.[0];
      if (!parent) return undefined;

      // Extract text: prefer text field, fall back to blocks/attachments
      let content = parent.text || '';
      if (!content && (parent as Record<string, unknown>).blocks) {
        const blocks = (parent as Record<string, unknown>).blocks as Array<
          Record<string, unknown>
        >;
        content = blocks
          .map((b) => {
            if (b.type === 'section' && b.text && typeof b.text === 'object') {
              return (b.text as Record<string, string>).text || '';
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
      }
      if (!content && (parent as Record<string, unknown>).attachments) {
        const atts = (parent as Record<string, unknown>).attachments as Array<
          Record<string, string>
        >;
        content = atts
          .map((a) => [a.pretext, a.title, a.text].filter(Boolean).join(' — '))
          .filter(Boolean)
          .join('\n');
      }
      if (!content) content = '[message with no text content]';

      const isBotMessage = !!(parent as Record<string, unknown>).bot_id;
      const senderName = isBotMessage
        ? (parent as Record<string, string>).username || 'bot'
        : parent.user
          ? (await this.resolveUserName(parent.user)) || parent.user
          : 'unknown';

      const timestamp = new Date(parseFloat(parent.ts!) * 1000).toISOString();

      return {
        id: parent.ts!,
        chat_jid: jid,
        sender: parent.user || (parent as Record<string, string>).bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: isBotMessage,
      };
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to fetch thread parent via API');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const { channelId, threadTs } = parseSlackJid(item.jid);
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
