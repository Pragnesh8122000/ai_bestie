import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app';
import { generateToken } from '../utils/jwt';

describe('POST /api/personas', () => {
  it('disables persona creation without touching existing records', async () => {
    const token = generateToken('persona-creation-disabled-user');
    const response = await request(app)
      .post('/api/personas')
      .set('Cookie', `token=${token}`)
      .send({
        name: 'New persona',
        archetype: 'friend',
        avatarId: 'friend-male-01',
      })
      .expect(405);

    expect(response.body).toEqual({
      success: false,
      code: 'PERSONA_CREATION_DISABLED',
      message: 'Persona creation is not available in this release. Choose an existing persona.',
    });
  });
});
