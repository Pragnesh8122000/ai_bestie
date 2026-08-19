import mongoose, { Document, Schema, Types } from 'mongoose';

/** Longest preview snippet stored for the conversation list. */
export const PREVIEW_MAX_LENGTH = 120;

export interface IMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  tokenCount: number;
}

export interface IConversation extends Document {
  userId: Types.ObjectId;
  personaId: Types.ObjectId;
  avatarId: string;
  title: string;
  titleIsCustom: boolean;
  messages: IMessage[];
  messageCount: number;
  lastMessagePreview: string;
  isArchived: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  lastMessageAt: Date;
  addMessage(role: 'user' | 'assistant', content: string, tokenCount?: number): void;
  getRecentMessages(limit?: number): IMessage[];
}

/**
 * Collapse whitespace and clip to `PREVIEW_MAX_LENGTH` for the list snippet.
 * Exported so the service layer's atomic `$set` writes produce byte-identical
 * previews to the document method below.
 */
export function toPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_LENGTH);
}

const messageSchema = new Schema<IMessage>(
  {
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    tokenCount: {
      type: Number,
      default: 0,
    },
  },
  { _id: false },
);

const conversationSchema = new Schema<IConversation>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    personaId: {
      type: Schema.Types.ObjectId,
      ref: 'Persona',
      required: true,
    },
    avatarId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      default: 'New Conversation',
      trim: true,
    },
    // Set once the user renames a conversation by hand, which permanently opts
    // it out of auto-titling from the first user message.
    titleIsCustom: {
      type: Boolean,
      default: false,
    },
    messages: [messageSchema],
    // Denormalized so the list endpoint never has to load the messages array.
    messageCount: {
      type: Number,
      default: 0,
    },
    lastMessagePreview: {
      type: String,
      default: '',
      maxlength: PREVIEW_MAX_LENGTH,
      trim: true,
    },
    // Soft delete: hides the conversation everywhere without racing an
    // in-flight stream that already holds the document.
    isArchived: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Indexes — the list query is {userId, isArchived} sorted by lastMessageAt desc.
conversationSchema.index({ userId: 1, isArchived: 1, lastMessageAt: -1 });

// NOTE: an `expiresAt` TTL index used to live here and deleted every
// conversation 48h after its last message. It is gone; chat history is now
// permanent. Existing documents may still carry a stale `expiresAt` field,
// which is harmless once the index itself is dropped — see
// `src/scripts/migrate-multiconvo.ts`.

// Instance methods
conversationSchema.methods.addMessage = function (
  role: 'user' | 'assistant',
  content: string,
  tokenCount: number = 0,
): void {
  this.messages.push({ role, content, timestamp: new Date(), tokenCount });
  this.messageCount = this.messages.length;
  this.lastMessagePreview = toPreview(content);
  this.lastMessageAt = new Date();
};

conversationSchema.methods.getRecentMessages = function (limit: number = 20): IMessage[] {
  return this.messages.slice(-limit);
};

conversationSchema.set('toJSON', { virtuals: true });

export const Conversation = mongoose.model<IConversation>('Conversation', conversationSchema);
