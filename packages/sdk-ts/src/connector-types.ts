// sdk-ts/src/connector-types.ts — MediaItem and Mention re-exports for the SDK

export interface MediaItem {
  kind: 'image' | 'audio' | 'video' | 'document' | 'sticker'
  url?: string
  localPath?: string
  mimeType?: string
  fileName?: string
  durationMs?: number
  isVoice: boolean
}

export interface Mention {
  userId: string
  name: string
  isSelf: boolean
}
