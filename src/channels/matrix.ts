import fs from 'fs';
import path from 'path';

import {
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
  RustSdkCryptoStoreType,
} from 'matrix-bot-sdk';

import { STORE_DIR, GROUPS_DIR } from '../config.js';
import {
  insertOutboundEvent,
  getLatestOutboundEvent,
  storeChatMetadata,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_TIMEOUT_MS = 60_000;
const TYPING_TIMEOUT_MS = 30_000;
const MAX_QUEUE_PER_ROOM = 100;
const DEFAULT_MAX_FILE_SIZE = 52_428_800; // 50 MB
const UTD_WINDOW_MS = 5 * 60_000;
const UTD_THRESHOLD = 3;

const ALLOWED_MEDIA_TYPES = new Set([
  'm.file',
  'm.image',
  'm.audio',
  'm.video',
]);

// ---------------------------------------------------------------------------
// MatrixChannel
// ---------------------------------------------------------------------------

export class MatrixChannel implements Channel {
  readonly name = 'matrix';

  private client!: MatrixClient;
  private connected = false;
  private botUserId = '';
  private lastSyncAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  // Outbound queue for when disconnected
  private outboundQueue = new Map<string, Array<{ text: string }>>();

  // Sender display-name cache: "roomId\0sender" → displayName
  private displayNameCache = new Map<string, string>();

  // UTD rate tracking per room
  private utdCounts = new Map<string, { count: number; windowStart: number }>();

  private readonly opts: ChannelOpts;
  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly e2eeEnabled: boolean;
  private readonly autoJoin: boolean;
  private readonly allowedSenders: Set<string>;
  private readonly maxFileSize: number;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    this.homeserverUrl = process.env.MATRIX_HOMESERVER_URL!;
    this.accessToken = process.env.MATRIX_ACCESS_TOKEN!;
    this.e2eeEnabled = process.env.MATRIX_E2EE === 'true';
    this.autoJoin = process.env.MATRIX_AUTO_JOIN === 'true';
    this.allowedSenders = new Set(
      (process.env.MATRIX_ALLOWED_SENDERS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    this.maxFileSize =
      Number(process.env.MATRIX_MAX_FILE_SIZE) || DEFAULT_MAX_FILE_SIZE;
  }

  // -----------------------------------------------------------------------
  // Channel interface
  // -----------------------------------------------------------------------

  async connect(): Promise<void> {
    const storagePath = path.join(STORE_DIR, 'matrix');
    fs.mkdirSync(storagePath, { recursive: true });

    const storage = new SimpleFsStorageProvider(
      path.join(storagePath, 'bot.json'),
    );

    const cryptoProvider = this.e2eeEnabled
      ? new RustSdkCryptoStorageProvider(
          path.join(STORE_DIR, 'matrix-crypto'),
          RustSdkCryptoStoreType.Sqlite,
        )
      : undefined;

    this.client = new MatrixClient(
      this.homeserverUrl,
      this.accessToken,
      storage,
      cryptoProvider,
    );

    // Register event handlers before starting sync
    this.registerEventHandlers();

    try {
      await this.client.start();
      this.botUserId = await this.client.getUserId();
      this.connected = true;
      this.lastSyncAt = Date.now();
      this.startHeartbeat();
      logger.info({ userId: this.botUserId }, 'Matrix: connected');

      // Drain any queued messages
      await this.drainQueues();
    } catch (err) {
      logger.error({ err }, 'Matrix: failed to connect');
      this.connected = false;
      throw err;
    }
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    if (!this.connected) {
      this.enqueue(roomId, text);
      return;
    }

    try {
      const eventId = await this.client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: text,
        format: 'org.matrix.custom.html',
        formatted_body: text,
      });
      insertOutboundEvent(eventId, roomId, 'matrix');
    } catch (err) {
      logger.error({ err, roomId }, 'Matrix: sendMessage failed');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('!') && jid.includes(':');
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.client?.stop();
    } catch {
      // ignore
    }
    this.connected = false;
    logger.info('Matrix: disconnected');
  }

  async setTyping(roomId: string, isTyping: boolean): Promise<void> {
    try {
      await this.client.setTyping(roomId, isTyping, TYPING_TIMEOUT_MS);
    } catch {
      // Non-critical — ignore
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    const roomIds = await this.client.getJoinedRooms();
    const botUserId = this.botUserId;

    for (const roomId of roomIds) {
      try {
        const name = await this.resolveRoomName(roomId);
        const members = await this.client.getJoinedRoomMembers(roomId);
        const isGroup = members.length > 2;
        const now = new Date().toISOString();
        this.opts.onChatMetadata(roomId, now, name, 'matrix', isGroup);
      } catch (err) {
        logger.warn({ err, roomId }, 'Matrix: syncGroups failed for room');
      }
    }
  }

  // -----------------------------------------------------------------------
  // Matrix-specific methods (not on Channel interface)
  // -----------------------------------------------------------------------

  async sendReaction(
    roomId: string,
    targetEventId: string,
    emoji: string,
  ): Promise<void> {
    await this.client.sendEvent(roomId, 'm.reaction', {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: targetEventId,
        key: emoji,
      },
    });
  }

  async reactToLatestMessage(roomId: string, emoji: string): Promise<void> {
    const eventId = getLatestOutboundEvent(roomId);
    if (!eventId) {
      logger.warn({ roomId }, 'Matrix: no outbound event to react to');
      return;
    }
    await this.sendReaction(roomId, eventId, emoji);
  }

  async sendFile(
    roomId: string,
    filePath: string,
    mimetype: string,
    fileName: string,
    caption?: string,
  ): Promise<void> {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length > this.maxFileSize) {
      logger.warn(
        { roomId, fileName, size: buffer.length },
        'Matrix: file exceeds max size, skipping',
      );
      return;
    }

    const msgtype = this.mimeToMsgtype(mimetype);
    let content: Record<string, unknown>;

    const isEncrypted =
      this.e2eeEnabled && (await this.client.crypto?.isRoomEncrypted(roomId));

    if (isEncrypted) {
      const encrypted = await this.client.crypto.encryptMedia(buffer);
      const mxcUri = await this.client.uploadContent(
        encrypted.buffer,
        'application/octet-stream',
        fileName,
      );
      content = {
        msgtype,
        body: caption || fileName,
        filename: fileName,
        info: { mimetype, size: buffer.length },
        file: { ...encrypted.file, url: mxcUri },
      };
    } else {
      const mxcUri = await this.client.uploadContent(
        buffer,
        mimetype,
        fileName,
      );
      content = {
        msgtype,
        body: caption || fileName,
        filename: fileName,
        info: { mimetype, size: buffer.length },
        url: mxcUri,
      };
    }

    const eventId = await this.client.sendMessage(roomId, content);
    insertOutboundEvent(eventId, roomId, 'matrix');
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  private registerEventHandlers(): void {
    // Inbound messages
    this.client.on('room.message', this.onRoomMessage.bind(this));

    // Invites
    this.client.on('room.invite', this.onRoomInvite.bind(this));

    // Room events (reactions, edits, lifecycle)
    this.client.on('room.event', this.onRoomEvent.bind(this));

    // UTD (Unable to Decrypt)
    this.client.on(
      'room.failed_decryption',
      this.onFailedDecryption.bind(this),
    );
  }

  private async onRoomMessage(roomId: string, event: any): Promise<void> {
    // Track sync activity for heartbeat
    this.lastSyncAt = Date.now();

    // Ignore own messages
    if (event.sender === this.botUserId) return;

    // Handle edits: extract original content or edited content
    const relatesTo = event.content?.['m.relates_to'];
    const isEdit = relatesTo?.rel_type === 'm.replace';
    const msgtype = event.content?.msgtype;

    // Resolve sender name
    const senderName = await this.resolveSenderName(roomId, event.sender);

    // Determine group status
    const members = await this.client.getJoinedRoomMembers(roomId);
    const isGroup = members.length > 2;
    const roomName = await this.resolveRoomName(roomId);
    const timestamp = new Date(event.origin_server_ts).toISOString();

    // Always emit metadata for discovery
    this.opts.onChatMetadata(roomId, timestamp, roomName, 'matrix', isGroup);

    // Only process messages for registered chats
    const registered = this.opts.registeredGroups();
    if (!registered[roomId]) return;

    // Send read receipt
    try {
      await this.client.sendReadReceipt(roomId, event.event_id);
    } catch {
      // Non-critical
    }

    // Handle media attachments
    if (msgtype && ALLOWED_MEDIA_TYPES.has(msgtype)) {
      await this.handleInboundMedia(roomId, event, senderName, timestamp);
      return;
    }

    // Text messages
    let textContent = event.content?.body || '';
    if (isEdit) {
      const newContent = event.content?.['m.new_content'];
      textContent = `[edited] ${newContent?.body || textContent}`;
    }

    if (!textContent) return;

    this.opts.onMessage(roomId, {
      id: event.event_id,
      chat_jid: roomId,
      sender: event.sender,
      sender_name: senderName,
      content: textContent,
      timestamp,
      is_from_me: false,
    });
  }

  private async onRoomInvite(roomId: string, event: any): Promise<void> {
    if (!this.autoJoin) {
      logger.info({ roomId, sender: event.sender }, 'Matrix: invite received (auto-join disabled)');
      return;
    }

    if (
      this.allowedSenders.size > 0 &&
      !this.allowedSenders.has(event.sender)
    ) {
      logger.info(
        { roomId, sender: event.sender },
        'Matrix: invite rejected (sender not in allowlist)',
      );
      return;
    }

    try {
      await this.client.joinRoom(roomId);
      logger.info({ roomId, sender: event.sender }, 'Matrix: auto-joined room');
    } catch (err) {
      logger.warn({ err, roomId }, 'Matrix: failed to auto-join room');
    }
  }

  private async onRoomEvent(roomId: string, event: any): Promise<void> {
    this.lastSyncAt = Date.now();

    // Room tombstone (upgrade)
    if (event.type === 'm.room.tombstone') {
      const newRoomId = event.content?.replacement_room;
      logger.warn(
        { roomId, newRoomId },
        'Matrix: room upgraded — re-register the new room',
      );
      return;
    }

    // Kick/Ban detection
    if (
      event.type === 'm.room.member' &&
      event.state_key === this.botUserId &&
      (event.content?.membership === 'leave' ||
        event.content?.membership === 'ban')
    ) {
      logger.warn(
        { roomId, membership: event.content.membership },
        'Matrix: bot removed from room',
      );
      return;
    }

    // Invalidate display name cache on member state change
    if (event.type === 'm.room.member' && event.state_key) {
      this.displayNameCache.delete(`${roomId}\0${event.state_key}`);
    }
  }

  private onFailedDecryption(
    roomId: string,
    event: any,
    error: Error,
  ): void {
    logger.warn(
      { roomId, eventId: event.event_id, error: error.message },
      'UTD: failed to decrypt event',
    );

    // Rate-limit UTD warnings
    const now = Date.now();
    const entry = this.utdCounts.get(roomId) || {
      count: 0,
      windowStart: now,
    };

    if (now - entry.windowStart > UTD_WINDOW_MS) {
      entry.count = 1;
      entry.windowStart = now;
    } else {
      entry.count++;
    }
    this.utdCounts.set(roomId, entry);

    if (entry.count === UTD_THRESHOLD) {
      logger.error(
        { roomId, count: entry.count },
        'UTD: multiple decryption failures — consider restoring crypto store from backup',
      );
    }
  }

  // -----------------------------------------------------------------------
  // Media handling
  // -----------------------------------------------------------------------

  private async handleInboundMedia(
    roomId: string,
    event: any,
    senderName: string,
    timestamp: string,
  ): Promise<void> {
    const content = event.content;
    const fileName = content.filename || content.body || 'attachment';
    const fileSize = content.info?.size || 0;

    if (fileSize > this.maxFileSize) {
      logger.warn(
        { roomId, fileName, size: fileSize },
        'Matrix: inbound file exceeds max size, skipping download',
      );
      return;
    }

    // Find the group folder for this room
    const registered = this.opts.registeredGroups();
    const group = registered[roomId];
    if (!group) return;

    try {
      let buffer: Buffer;

      if (content.file) {
        // Encrypted attachment
        buffer = await this.client.crypto.decryptMedia(content.file);
      } else if (content.url) {
        // Plaintext attachment
        const result = await this.client.downloadContent(content.url);
        buffer = result.data;
      } else {
        return;
      }

      // Save to group workspace
      const attachDir = path.join(GROUPS_DIR, group.folder, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      const safeName = path
        .basename(fileName)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .substring(0, 200);
      const savedPath = path.join(
        attachDir,
        `${Date.now()}_${safeName}`,
      );
      fs.writeFileSync(savedPath, buffer);

      const attachmentNote = `[Attachment saved: ${savedPath}]`;
      this.opts.onMessage(roomId, {
        id: event.event_id,
        chat_jid: roomId,
        sender: event.sender,
        sender_name: senderName,
        content: content.body
          ? `${content.body}\n${attachmentNote}`
          : attachmentNote,
        timestamp,
        is_from_me: false,
      });
    } catch (err) {
      logger.error({ err, roomId, fileName }, 'Matrix: failed to download attachment');
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async resolveSenderName(
    roomId: string,
    sender: string,
  ): Promise<string> {
    const key = `${roomId}\0${sender}`;
    const cached = this.displayNameCache.get(key);
    if (cached) return cached;

    try {
      const memberState = await this.client.getRoomStateEvent(
        roomId,
        'm.room.member',
        sender,
      );
      const name = memberState?.displayname || sender;
      this.displayNameCache.set(key, name);
      return name;
    } catch {
      return sender;
    }
  }

  private async resolveRoomName(roomId: string): Promise<string> {
    try {
      const nameEvent = await this.client.getRoomStateEvent(
        roomId,
        'm.room.name',
        '',
      );
      if (nameEvent?.name) return nameEvent.name;
    } catch {
      // no name set
    }

    try {
      const aliasEvent = await this.client.getRoomStateEvent(
        roomId,
        'm.room.canonical_alias',
        '',
      );
      if (aliasEvent?.alias) return aliasEvent.alias;
    } catch {
      // no alias
    }

    // Fall back to member summary for DMs
    try {
      const members = await this.client.getJoinedRoomMembers(roomId);
      const others = members.filter((m) => m !== this.botUserId);
      if (others.length === 1) {
        const name = await this.resolveSenderName(roomId, others[0]);
        return `DM with ${name}`;
      }
    } catch {
      // ignore
    }

    return `Room ${roomId.substring(0, 12)}`;
  }

  private mimeToMsgtype(mime: string): string {
    if (mime.startsWith('image/')) return 'm.image';
    if (mime.startsWith('audio/')) return 'm.audio';
    if (mime.startsWith('video/')) return 'm.video';
    return 'm.file';
  }

  // -----------------------------------------------------------------------
  // Heartbeat & reconnection
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastSyncAt > HEARTBEAT_TIMEOUT_MS) {
        logger.warn('Matrix: sync heartbeat timeout — marking disconnected');
        this.connected = false;
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  // -----------------------------------------------------------------------
  // Outbound queue
  // -----------------------------------------------------------------------

  private enqueue(roomId: string, text: string): void {
    let queue = this.outboundQueue.get(roomId);
    if (!queue) {
      queue = [];
      this.outboundQueue.set(roomId, queue);
    }
    if (queue.length >= MAX_QUEUE_PER_ROOM) {
      queue.shift(); // drop oldest
      logger.warn({ roomId }, 'Matrix: outbound queue full, dropping oldest');
    }
    queue.push({ text });
  }

  private async drainQueues(): Promise<void> {
    for (const [roomId, queue] of this.outboundQueue) {
      for (const msg of queue) {
        try {
          await this.sendMessage(roomId, msg.text);
        } catch (err) {
          logger.warn({ err, roomId }, 'Matrix: failed to drain queued message');
        }
      }
    }
    this.outboundQueue.clear();
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerChannel('matrix', (opts: ChannelOpts) => {
  if (!process.env.MATRIX_ACCESS_TOKEN || !process.env.MATRIX_HOMESERVER_URL) {
    logger.warn('Matrix: credentials not found, skipping');
    return null;
  }
  return new MatrixChannel(opts);
});
