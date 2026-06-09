// connectors/types.ts — ConnectorInterface, NormalizedMessage, MediaItem, Mention
// This file is the SINGLE SOURCE OF TRUTH for NormalizedMessage.
// No platform-specific fields may appear here.

export interface MediaItem {
  kind: 'image' | 'audio' | 'video' | 'document' | 'sticker'
  /** Remote URL if the platform provides one. */
  url?: string
  /** Local path if the gateway downloaded the file. */
  localPath?: string
  mimeType?: string
  fileName?: string
  /** Duration in milliseconds — for audio/video. */
  durationMs?: number
  /** True if audio was recorded as a voice message. */
  isVoice: boolean
}

export interface Mention {
  /** Platform user ID of the mentioned person. */
  userId: string
  /** Display name — connector resolves this. */
  name: string
  /** True if this mention refers to the bot itself. */
  isSelf: boolean
}

export interface NormalizedMessage {
  /** Platform-assigned message ID (opaque string). */
  id: string

  sender: {
    id: string
    name: string
    /** True if the sender is the bot itself (triggers drop in Stage 2). */
    isSelf: boolean
  }

  chat: {
    id: string
    kind: 'dm' | 'group' | 'channel' | 'thread'
  }

  /**
   * Clean text: platform-specific syntax resolved, bot @mention removed.
   * May be empty if the message is media-only.
   */
  text: string

  /** Original unmodified text from the platform. */
  textRaw: string

  media: MediaItem[]

  content: {
    mentions: Mention[]
  }

  routing: {
    /** Connector resolved whether this message is addressed to the bot. */
    isAgentAddressed: boolean
    /** Which bot account received this message. */
    accountId: string
  }

  /** Original platform payload — opaque to gateway core. */
  raw: unknown
}

export interface DeliveryTarget {
  /** Platform-native chat ID. */
  chatId: string
  /** If set, send as a reply to this platform message ID. */
  replyToMessageId?: string
}

export interface DeliveryResult {
  /** True if delivery was confirmed by the platform. */
  ok: boolean
  /** Platform-assigned message ID for the sent message, if available. */
  sentMessageId?: string
}

export interface ConnectorInterface {
  /** Unique identifier matching gateway.config.yaml connectors[].accountId. */
  readonly accountId: string
  /** Connector type name e.g. "telegram", "slack". */
  readonly type: string

  /** Start the connection (polling loop or webhook registration). */
  startAccount(): Promise<void>

  /** Gracefully stop the connection. */
  stopAccount(): Promise<void>

  /** True if the connector is currently connected and healthy. */
  isHealthy(): boolean

  /**
   * Send text (and optional media) to a chat.
   * Called by the pipeline reliability layer via send_with_retry.
   */
  send(target: DeliveryTarget, text: string, media?: MediaItem[]): Promise<DeliveryResult>

  /**
   * Send a typing indicator to the given chat.
   * Called repeatedly by keep_typing() every ~2 seconds.
   */
  sendTyping(chatId: string): Promise<void>

  /**
   * Register the callback the gateway core invokes when a new message arrives.
   * Connector calls this callback after normalize() → NormalizedMessage.
   * Connector must NOT call this for null normalize() results.
   */
  onMessage(callback: (msg: NormalizedMessage) => void): void

  // ── Streaming (v1) ────────────────────────────────────────────────────────

  /**
   * True if this connector can deliver stream chunks to the user progressively.
   *
   * When false (or absent), the pipeline buffers all StreamChunks from the
   * adapter, assembles the full response, and calls send() exactly once — the
   * same behaviour as v0. This is correct for platforms whose APIs do not
   * support editing or appending to an in-flight message (e.g. WeChat iLink).
   *
   * When true, the pipeline calls sendChunk() for each chunk as it arrives.
   * The connector is responsible for its own rate-limiting and debouncing.
   *
   * Defaults to false when absent.
   */
  readonly supportsStreaming?: boolean

  /**
   * Deliver one stream chunk progressively to the user.
   * Called only when supportsStreaming is true.
   *
   * @param target     The destination chat.
   * @param chunk      The current StreamChunk (delta + done flag).
   * @param accumulated The full response text assembled so far (all deltas
   *                   concatenated). Connectors that edit a message in place
   *                   (e.g. Slack chat.update) should replace the message
   *                   content with this value rather than appending delta.
   */
  sendChunk?(
    target: DeliveryTarget,
    chunk: import('../adapter/types.js').StreamChunk,
    accumulated: string,
  ): Promise<void>
}
