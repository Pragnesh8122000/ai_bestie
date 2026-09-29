import mongoose from 'mongoose';
import { config } from './config';
import { User } from './models/User';
import { Persona } from './models/Persona';

const seed = async () => {
  try {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Refusing to seed a production database');
    }
    const email = process.env.SEED_USER_EMAIL?.trim();
    const password = process.env.SEED_USER_PASSWORD;
    if (!email || !password) {
      throw new Error('Set SEED_USER_EMAIL and SEED_USER_PASSWORD in .env to seed a test user');
    }

    await mongoose.connect(config.mongodb.uri);
    console.log('Connected to MongoDB for seeding');

    // Create a test user
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log('Test user already exists, skipping seed');
      await mongoose.disconnect();
      return;
    }

    const user = await User.create({
      email,
      password,
      name: 'Test User',
      authProviders: ['password'],
    });

    console.log(`Created test user: ${user.email} (${user._id})`);

    // Create a default mentor persona for the test user
    const persona = await Persona.create({
      userId: user._id,
      name: 'Atlas',
      archetype: 'mentor',
      avatarId: 'mentor-male-01',
      traits: {
        directness: 7,
        warmth: 6,
        proactivity: 7,
        depth: 8,
        accountability: 7,
      },
    });

    console.log(`Created default persona: ${persona.name} (${persona._id})`);

    // Update user's active persona
    user.activePersonaId = persona._id;
    await user.save();

    console.log('\nSeed data created successfully!');
    console.log(`Test user ready: ${email} (password from SEED_USER_PASSWORD)`);

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
};

seed();
