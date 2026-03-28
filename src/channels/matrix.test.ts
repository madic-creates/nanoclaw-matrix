import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { MatrixChannel } from './matrix.js';
import { ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('matrix-bot-sdk', () => {
  const mockClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getUserId: vi.fn().mockResolvedValue('@bot:example.com'),
    on: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('$event1'),
    sendEvent: vi.fn().mockResolvedValue('$reaction1'),
    setTyping: vi.fn().mockResolvedValue(undefined),
    getJoinedRooms: vi.fn().mockResolvedValue([]),
    getJoinedRoomMembers: vi.fn().mockResolvedValue(['@bot:example.com', '@user:example.com']),
    getRoomStateEvent: vi.fn().mockResolvedValue({ name: 'Test Room' }),
    joinRoom: vi.fn().mockResolvedValue('!joined:example.com'),
    sendReadReceipt: vi.fn().mockResolvedValue(undefined),
    uploadContent: vi.fn().mockResolvedValue('mxc://example.com/abc'),
    downloadContent: vi.fn().mockResolvedValue({ data: Buffer.from('file'), contentType: 'application/octet-stream' }),
    crypto: {
      isRoomEncrypted: vi.fn().mockResolvedValue(false),
      encryptMedia: vi.fn().mockResolvedValue({ buffer: Buffer.from('encrypted'), file: { key: 'k', iv: 'i', hashes: {} } }),
      decryptMedia: vi.fn().mockResolvedValue(Buffer.from('decrypted')),
    },
  };

  return {
    MatrixClient: vi.fn().mockImplementation(function () { return mockClient; }),
    SimpleFsStorageProvider: vi.fn().mockImplementation(function () { return {}; }),
    RustSdkCryptoStorageProvider: vi.fn().mockImplementation(function () { return {}; }),
    RustSdkCryptoStoreType: { Sqlite: 0 },
    __mockClient: mockClient,
  };
});

// Access the mock client for assertions
async function getMockClient() {
  const mod = await import('matrix-bot-sdk');
  return (mod as any).__mockClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<ChannelOpts> = {}): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v;
  }
}

function clearEnv() {
  delete process.env.MATRIX_HOMESERVER_URL;
  delete process.env.MATRIX_ACCESS_TOKEN;
  delete process.env.MATRIX_E2EE;
  delete process.env.MATRIX_AUTO_JOIN;
  delete process.env.MATRIX_ALLOWED_SENDERS;
  delete process.env.MATRIX_MAX_FILE_SIZE;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MatrixChannel', () => {
  beforeEach(() => {
    _initTestDatabase();
    clearEnv();
    setEnv({
      MATRIX_HOMESERVER_URL: 'https://matrix.example.com',
      MATRIX_ACCESS_TOKEN: 'syt_test_token',
    });
  });

  afterEach(() => {
    _closeDatabase();
    clearEnv();
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('matches Matrix room IDs', () => {
      const ch = new MatrixChannel(makeOpts());
      expect(ch.ownsJid('!abc123:server.example')).toBe(true);
      expect(ch.ownsJid('!room:matrix.org')).toBe(true);
    });

    it('rejects non-Matrix JIDs', () => {
      const ch = new MatrixChannel(makeOpts());
      expect(ch.ownsJid('123456@g.us')).toBe(false);
      expect(ch.ownsJid('tg:123456')).toBe(false);
      expect(ch.ownsJid('slack:C012345')).toBe(false);
      expect(ch.ownsJid('dc:12345')).toBe(false);
      expect(ch.ownsJid('@user:example.com')).toBe(false);
    });

    it('matches federated room IDs from other servers', () => {
      const ch = new MatrixChannel(makeOpts());
      expect(ch.ownsJid('!federated:other.server')).toBe(true);
    });

    it('rejects strings without colon', () => {
      const ch = new MatrixChannel(makeOpts());
      expect(ch.ownsJid('!nocolon')).toBe(false);
    });

    it('rejects empty string', () => {
      const ch = new MatrixChannel(makeOpts());
      expect(ch.ownsJid('')).toBe(false);
    });
  });

  // --- connect ---

  describe('connect', () => {
    it('connects and sets connected state', async () => {
      const ch = new MatrixChannel(makeOpts());
      await ch.connect();
      expect(ch.isConnected()).toBe(true);
    });

    it('handles connection failure', async () => {
      const mockClient = await getMockClient();
      mockClient.start.mockRejectedValueOnce(new Error('auth failed'));

      const ch = new MatrixChannel(makeOpts());
      await expect(ch.connect()).rejects.toThrow('auth failed');
      expect(ch.isConnected()).toBe(false);
    });
  });

  // --- disconnect ---

  describe('disconnect', () => {
    it('disconnects cleanly', async () => {
      const ch = new MatrixChannel(makeOpts());
      await ch.connect();
      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends m.text message with formatted_body', async () => {
      const mockClient = await getMockClient();
      const ch = new MatrixChannel(makeOpts());
      await ch.connect();

      await ch.sendMessage('!room:example.com', 'Hello world');

      expect(mockClient.sendMessage).toHaveBeenCalledWith(
        '!room:example.com',
        expect.objectContaining({
          msgtype: 'm.text',
          body: 'Hello world',
          format: 'org.matrix.custom.html',
          formatted_body: 'Hello world',
        }),
      );
    });

    it('queues messages when disconnected', async () => {
      const ch = new MatrixChannel(makeOpts());
      // Don't connect — channel is disconnected
      await ch.sendMessage('!room:example.com', 'queued');
      expect(ch.isConnected()).toBe(false);
      // No throw — message is queued silently
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('calls client.setTyping', async () => {
      const mockClient = await getMockClient();
      const ch = new MatrixChannel(makeOpts());
      await ch.connect();

      await ch.setTyping('!room:example.com', true);
      expect(mockClient.setTyping).toHaveBeenCalledWith(
        '!room:example.com',
        true,
        30000,
      );
    });
  });

  // --- sendReaction ---

  describe('sendReaction', () => {
    it('sends m.reaction event', async () => {
      const mockClient = await getMockClient();
      const ch = new MatrixChannel(makeOpts());
      await ch.connect();

      await ch.sendReaction('!room:example.com', '$target', '👍');

      expect(mockClient.sendEvent).toHaveBeenCalledWith(
        '!room:example.com',
        'm.reaction',
        {
          'm.relates_to': {
            rel_type: 'm.annotation',
            event_id: '$target',
            key: '👍',
          },
        },
      );
    });
  });

  // --- reactToLatestMessage ---

  describe('reactToLatestMessage', () => {
    it('reacts to latest outbound event from DB', async () => {
      const mockClient = await getMockClient();
      const ch = new MatrixChannel(makeOpts());
      await ch.connect();

      // Send a message first (inserts into outbound_events)
      await ch.sendMessage('!room:example.com', 'test');

      // Now react to it
      await ch.reactToLatestMessage('!room:example.com', '🎉');

      expect(mockClient.sendEvent).toHaveBeenCalledWith(
        '!room:example.com',
        'm.reaction',
        expect.objectContaining({
          'm.relates_to': expect.objectContaining({
            event_id: '$event1',
            key: '🎉',
          }),
        }),
      );
    });
  });

  // --- syncGroups ---

  describe('syncGroups', () => {
    it('calls onChatMetadata for each joined room', async () => {
      const mockClient = await getMockClient();
      mockClient.getJoinedRooms.mockResolvedValueOnce([
        '!room1:example.com',
        '!room2:example.com',
      ]);

      const onChatMetadata = vi.fn();
      const ch = new MatrixChannel(makeOpts({ onChatMetadata }));
      await ch.connect();

      await ch.syncGroups(false);

      expect(onChatMetadata).toHaveBeenCalledTimes(2);
      expect(onChatMetadata).toHaveBeenCalledWith(
        '!room1:example.com',
        expect.any(String),
        'Test Room',
        'matrix',
        false, // 2 members = DM
      );
    });
  });

  // --- name ---

  describe('channel name', () => {
    it('is "matrix"', () => {
      const ch = new MatrixChannel(makeOpts());
      expect(ch.name).toBe('matrix');
    });
  });
});

// --- Self-registration ---

describe('matrix self-registration', () => {
  it('registers channel factory', async () => {
    const { getChannelFactory } = await import('./registry.js');
    // The import of matrix.ts at the top triggers registerChannel
    const factory = getChannelFactory('matrix');
    expect(factory).toBeDefined();
  });

  it('factory returns null when credentials missing', async () => {
    clearEnv();
    const { getChannelFactory } = await import('./registry.js');
    const factory = getChannelFactory('matrix')!;
    const result = factory(makeOpts());
    expect(result).toBeNull();
  });

  it('factory returns MatrixChannel when credentials present', async () => {
    setEnv({
      MATRIX_HOMESERVER_URL: 'https://matrix.example.com',
      MATRIX_ACCESS_TOKEN: 'syt_test',
    });
    const { getChannelFactory } = await import('./registry.js');
    const factory = getChannelFactory('matrix')!;
    const result = factory(makeOpts());
    expect(result).toBeInstanceOf(MatrixChannel);
  });
});
