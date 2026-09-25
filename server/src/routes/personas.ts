import { Router } from 'express';
import { ZodError } from 'zod';
import { Persona } from '../models/Persona';
import { catchAsync, AppError } from '../utils/errors';
import { requireAuth } from '../middleware/auth';
import { getArchetypes } from '../services/personaService';
import { updatePersonaSchema } from '../validations/persona';

const router = Router();

// GET /api/personas/archetypes — list available archetypes (public: guests can
// browse archetypes without signing in, per the guest read-only mode)
router.get('/archetypes', (_req, res) => {
  res.json({ success: true, data: { archetypes: getArchetypes() } });
});

// Every other persona route is user-owned data and requires authentication
router.use(requireAuth);

// GET /api/personas — list current user's personas
router.get(
  '/',
  catchAsync(async (req, res) => {
    const personas = await Persona.find({ userId: req.userId }).lean();

    res.json({
      success: true,
      data: {
        personas: personas.map((p) => ({
          id: p._id.toHexString(),
          name: p.name,
          archetype: p.archetype,
          avatarId: p.avatarId,
          traits: p.traits,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      },
    });
  }),
);

// Persona creation is intentionally unavailable in this release. Existing
// records stay intact and remain selectable/editable.
router.post('/', (_req, res) => {
  res.status(405).json({
    success: false,
    code: 'PERSONA_CREATION_DISABLED',
    message: 'Persona creation is not available in this release. Choose an existing persona.',
  });
});

// GET /api/personas/:id — get a single persona
router.get(
  '/:id',
  catchAsync(async (req, res) => {
    const persona = await Persona.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).lean();

    if (!persona) {
      throw new AppError('Persona not found', 404);
    }

    res.json({
      success: true,
      data: {
        persona: {
          id: persona._id.toHexString(),
          name: persona.name,
          archetype: persona.archetype,
          avatarId: persona.avatarId,
          traits: persona.traits,
          createdAt: persona.createdAt,
          updatedAt: persona.updatedAt,
        },
      },
    });
  }),
);

// PATCH /api/personas/:id — update a persona
router.patch(
  '/:id',
  catchAsync(async (req, res, next) => {
    let input;
    try {
      input = updatePersonaSchema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
        });
        return;
      }
      return next(error);
    }

    const persona = await Persona.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!persona) {
      throw new AppError('Persona not found', 404);
    }

    // Apply updates
    if (input.name !== undefined) persona.name = input.name;
    if (input.avatarId !== undefined) persona.avatarId = input.avatarId;
    if (input.traits !== undefined) {
      persona.traits = { ...persona.traits, ...input.traits };
    }

    await persona.save(); // pre-save hook will clamp traits

    res.json({
      success: true,
      data: {
        persona: {
          id: persona.id,
          name: persona.name,
          archetype: persona.archetype,
          avatarId: persona.avatarId,
          traits: persona.traits,
          createdAt: persona.createdAt,
          updatedAt: persona.updatedAt,
        },
      },
    });
  }),
);

// DELETE /api/personas/:id — delete a persona
router.delete(
  '/:id',
  catchAsync(async (req, res) => {
    const result = await Persona.deleteOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (result.deletedCount === 0) {
      throw new AppError('Persona not found', 404);
    }

    res.json({ success: true, message: 'Persona deleted' });
  }),
);

export default router;
