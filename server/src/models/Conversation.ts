import mongoose, { Document, Schema, Types } from 'mongoose';

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
  messages: IMessage[];
  createdAt: Date;
  lastMessageAt: Date;
  expiresAt: Date;
  addMessage(role: 'user' | 'assistant', content: string, tokenCount?: number): void;
  getRecentMessages(limit?: number): IMessage[];
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
    messages: [messageSchema],
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours from creation
    },
  },
  { timestamps: true },
);

// Indexes
conversationSchema.index({ userId: 1, lastMessageAt: -1 });
conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL

// Instance methods
conversationSchema.methods.addMessage = function (
  role: 'user' | 'assistant',
  content: string,
  tokenCount: number = 0,
): void {
  this.messages.push({ role, content, timestamp: new Date(), tokenCount });
  this.lastMessageAt = new Date();
  // Reset expiry to 48 hours from now on each message
  this.expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
};

conversationSchema.methods.getRecentMessages = function (limit: number = 20): IMessage[] {
  return this.messages.slice(-limit);
};

conversationSchema.set('toJSON', { virtuals: true });

export const Conversation = mongoose.model<IConversation>('Conversation', conversationSchema);