import { Router } from 'express';
import { z } from 'zod';
import { Conversation } from '../models/Conversation';
import { catchAsync, AppError } from '../utils/errors';
import { requireAuth, chatRateLimiter } from '../middleware/auth';
import {
  handleChatStream,
  createConversation,
  listConversations,
  ensureDefaultConversation,
  renameConversation,
  archiveConversation,
} from '../services/chatService';

const router = Router();

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/);

// All conversation routes require authentication
router.use(requireAuth);

// GET /api/conversations — list user's conversations (newest activity first)
router.get(
  '/',
  catchAsync(async (req, res) => {
    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      before: z.coerce.date().optional(),
    });

    const { limit, before } = querySchema.parse(req.query);
    const { conversations, hasMore } = await listConversations(req.userId!, { limit, before });

    res.json({ success: true, data: { conversations, hasMore } });
  }),
);

// GET /api/conversations/default — ensure + return the single Friend conversation
router.get(
  '/default',
  catchAsync(async (req, res) => {
    const { conversation, persona } = await ensureDefaultConversation(req.userId!);
    res.json({
      success: true,
      data: {
        conversation,
        persona: {
          id: persona._id.toHexString(),
          name: persona.name,
          archetype: persona.archetype,
          avatarId: persona.avatarId,
          traits: persona.traits,
        },
      },
    });
  }),
);

// POST /api/conversations — create a new conversation
router.post(
  '/',
  catchAsync(async (req, res) => {
    const schema = z.object({
      personaId: z.string().min(1),
      avatarId: z.string().min(1),
      title: z.string().max(100).optional(),
    });

    const input = schema.parse(req.body);

    const conversation = await createConversation(
      req.userId!,
      input.personaId,
      input.avatarId,
      input.title,
    );

    res.status(201).json({
      success: true,
      data: {
        conversation: {
          id: conversation._id.toHexString(),
          title: conversation.title,
          titleIsCustom: conversation.titleIsCustom,
          personaId: conversation.personaId.toString(),
          avatarId: conversation.avatarId,
          messages: [],
          messageCount: 0,
          lastMessagePreview: '',
          lastMessageAt: conversation.lastMessageAt,
          createdAt: conversation.createdAt,
        },
      },
    });
  }),
);

// GET /api/conversations/:id — get conversation with messages
router.get(
  '/:id',
  catchAsync(async (req, res) => {
    const idResult = objectIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      throw new AppError('Conversation not found', 404);
    }

    const conversation = await Conversation.findOne({
      _id: req.params.id,
      userId: req.userId,
      isArchived: false,
    }).lean();

    if (!conversation) {
      throw new AppError('Conversation not found', 404);
    }

    res.json({
      success: true,
      data: {
        conversation: {
          id: conversation._id.toString(),
          title: conversation.title,
          titleIsCustom: Boolean(conversation.titleIsCustom),
          personaId: conversation.personaId.toString(),
          avatarId: conversation.avatarId,
          messages: conversation.messages,
          messageCount: conversation.messageCount ?? conversation.messages.length,
          lastMessagePreview: conversation.lastMessagePreview ?? '',
          createdAt: conversation.createdAt,
          lastMessageAt: conversation.lastMessageAt,
        },
      },
    });
  }),
);

// POST /api/conversations/:id/messages/stream — SSE streaming chat
router.post(
  '/:id/messages/stream',
  chatRateLimiter,
  catchAsync(async (req, res) => {
    const idResult = objectIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      throw new AppError('Conversation not found', 404);
    }

    const schema = z.object({
      message: z.string().trim().min(1).max(10000),
    });

    const input = schema.parse(req.body);

    await handleChatStream(req.userId!, String(req.params.id), input.message, res);
  }),
);

// PATCH /api/conversations/:id — rename a conversation
router.patch(
  '/:id',
  catchAsync(async (req, res) => {
    const idResult = objectIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      throw new AppError('Conversation not found', 404);
    }

    const schema = z.object({
      title: z.string().trim().min(1).max(100),
    });

    const { title } = schema.parse(req.body);

    const conversation = await renameConversation(req.userId!, String(req.params.id), title);

    if (!conversation) {
      throw new AppError('Conversation not found', 404);
    }

    res.json({
      success: true,
      data: {
        conversation: {
          id: conversation._id.toString(),
          title: conversation.title,
          titleIsCustom: conversation.titleIsCustom,
          lastMessageAt: conversation.lastMessageAt,
        },
      },
    });
  }),
);

// DELETE /api/conversations/:id — soft-delete (archive) a conversation
router.delete(
  '/:id',
  catchAsync(async (req, res) => {
    const idResult = objectIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      throw new AppError('Conversation not found', 404);
    }

    const archived = await archiveConversation(req.userId!, String(req.params.id));

    if (!archived) {
      throw new AppError('Conversation not found', 404);
    }

    res.json({ success: true, message: 'Conversation deleted' });
  }),
);

export default router;