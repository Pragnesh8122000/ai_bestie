import { Router } from 'express';
import { avatarManifest, getAvatarById, getAvatarsByCategory } from '../data/avatarManifest';

const router = Router();

// GET /api/avatars — list all avatars, optional ?category= filter
router.get('/', (req, res) => {
  const { category } = req.query;

  if (category && typeof category === 'string') {
    const filtered = getAvatarsByCategory(category);
    return res.json({ success: true, data: { avatars: filtered } });
  }

  res.json({ success: true, data: { avatars: avatarManifest } });
});

// GET /api/avatars/:id — single avatar
router.get('/:id', (req, res) => {
  const avatar = getAvatarById(req.params.id);

  if (!avatar) {
    return res.status(404).json({
      success: false,
      message: `Avatar not found: ${req.params.id}`,
    });
  }

  res.json({ success: true, data: { avatar } });
});

export default router;