import mongoose from 'mongoose';
import { config } from './config';
import { User } from './models/User';
import { Persona } from './models/Persona';

const seed = async () => {
  try {
    await mongoose.connect(config.mongodb.uri);
    console.log('Connected to MongoDB for seeding');

    // Create a test user
    const existingUser = await User.findOne({ email: 'test@aibestie.com' });
    if (existingUser) {
      console.log('Test user already exists, skipping seed');
      await mongoose.disconnect();
      return;
    }

    const user = await User.create({
      email: 'test@aibestie.com',
      password: 'password123',
      name: 'Test User',
      authProvider: 'email',
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
    console.log('Test credentials: test@aibestie.com / password123');

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
};

seed();