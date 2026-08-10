import mongoose, { Document, Schema, Types } from 'mongoose';
import { archetypeConfigs } from '../data/archetypes';

export interface ITrait {
  directness: number;
  warmth: number;
  proactivity: number;
  depth: number;
  accountability: number;
}

export interface IPersona extends Document {
  userId: Types.ObjectId;
  name: string;
  archetype: 'mentor' | 'friend' | 'therapist' | 'coach';
  avatarId: string;
  traits: ITrait;
  createdAt: Date;
  updatedAt: Date;
  getSystemPrompt(): string;
}

const traitSchema = new Schema<ITrait>(
  {
    directness: { type: Number, default: 5, min: 1, max: 10 },
    warmth: { type: Number, default: 5, min: 1, max: 10 },
    proactivity: { type: Number, default: 5, min: 1, max: 10 },
    depth: { type: Number, default: 5, min: 1, max: 10 },
    accountability: { type: Number, default: 5, min: 1, max: 10 },
  },
  { _id: false },
);

const personaSchema = new Schema<IPersona>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    archetype: {
      type: String,
      enum: ['mentor', 'friend', 'therapist', 'coach'],
      required: true,
    },
    avatarId: {
      type: String,
      required: true,
    },
    traits: {
      type: traitSchema,
      default: () => ({}),
    },
  },
  { timestamps: true },
);

// Clamp trait values to archetype range before saving
personaSchema.pre('save', function (next) {
  const config = archetypeConfigs[this.archetype as keyof typeof archetypeConfigs];
  if (!config) return next();

  const traitKeys = ['directness', 'warmth', 'proactivity', 'depth', 'accountability'] as const;
  for (const key of traitKeys) {
    const range = config.traitRanges[key];
    this.traits[key] = Math.max(range.min, Math.min(range.max, this.traits[key]));
  }
  next();
});

// Virtual: assemble the 5-layer system prompt
personaSchema.methods.getSystemPrompt = function (): string {
  const config = archetypeConfigs[this.archetype as keyof typeof archetypeConfigs];
  if (!config) {
    throw new Error(`Unknown archetype: ${this.archetype}`);
  }

  const traitKeys = ['directness', 'warmth', 'proactivity', 'depth', 'accountability'] as const;

  // Layer 1: IDENTITY (immutable)
  const identity = [
    `You are ${this.name}, a ${config.displayName}.`,
    `Your core purpose: ${config.corePurpose}`,
    'You NEVER break character. You NEVER say you are an AI, a language model, or a chatbot.',
    'You NEVER say "As an AI" or "I\'m just a language model." Stay in character at all times.',
  ].join('\n');

  // Layer 2: VOICE (archetype-locked)
  const voice = config.voiceStyle;

  // Layer 3: BEHAVIORAL RULES (hard constraints)
  const rules = [
    'RULE 1: You NEVER prescribe medication or diagnose medical conditions.',
    'RULE 2: You NEVER encourage self-harm, violence, or illegal acts.',
    'RULE 3: If the user expresses suicidal thoughts, respond with crisis resources and gentle grounding. Suggest they reach out to a helpline (988 Suicide & Crisis Lifeline in the US).',
    'RULE 4: You NEVER provide financial, legal, or medical advice as professional counsel. You can share general knowledge, but always clarify you are not a professional.',
    'RULE 5: You maintain appropriate boundaries. You are supportive but not a substitute for professional help.',
  ].join('\n');

  // Layer 4: USER CONTEXT (session memory from the message history below)
  const context =
    'Relevant context from earlier in this conversation is provided in the message history below.';

  // Layer 5: TRAIT CALIBRATION (slider adjustments)
  const traitInstructions = traitKeys
    .map((key) => {
      const value = this.traits[key];
      const range = config.traitRanges[key];
      const descriptor = getTraitDescriptor(key, value, range);
      return `- ${capitalize(key)} ${value}/10: ${descriptor}`;
    })
    .join('\n');

  const calibration = `Based on the user's preference settings:\n${traitInstructions}`;

  // Chain of Persona (CoP) self-check
  const copInstruction = [
    '',
    'Before responding, briefly consider:',
    '1. Would [your name] say this? Does it match your voice?',
    '2. Is this consistent with how you have been speaking in this conversation?',
    '3. Are you breaking any behavioral rules?',
    'If any answer is NO, revise before outputting.',
  ].join('\n');

  return [identity, voice, rules, context, calibration, copInstruction].join('\n\n');
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getTraitDescriptor(
  key: string,
  value: number,
  range: { min: number; max: number },
): string {
  const descriptions: Record<string, Record<string, string>> = {
    directness: {
      low: "Be gentle and indirect. Soften feedback. Use cushioning language.",
      mid: "Be balanced. Give honest feedback with warmth.",
      high: "Be straightforward and direct. Don't soften feedback, but maintain respect.",
    },
    warmth: {
      low: "Be reserved and matter-of-fact. Focus on information over emotion.",
      mid: "Show genuine care. Use affirming language when appropriate.",
      high: "Be warmly expressive. Show empathy and emotional attunement openly.",
    },
    proactivity: {
      low: "Be reactive. Wait for the user to ask before offering suggestions.",
      mid: "Offer suggestions when relevant, but ask first.",
      high: "Be proactive. Offer solutions and suggestions readily. Don't just ask questions.",
    },
    depth: {
      low: "Keep responses surface-level. Brief and practical.",
      mid: "Go beyond surface advice. Explore root causes when relevant.",
      high: "Dive deep. Explore root causes, philosophical underpinnings, and systemic patterns.",
    },
    accountability: {
      low: "Be supportive and validating. Don't push or challenge.",
      mid: "Gently challenge. Follow up on commitments. Balance support with accountability.",
      high: "Hold the user accountable. Challenge excuses. Follow up on commitments firmly.",
    },
  };

  const desc = descriptions[key] || {};
  const midPoint = (range.min + range.max) / 2;
  const midRange = (range.max - range.min) / 3;

  if (value <= range.min + midRange) return desc.low || '';
  if (value >= range.max - midRange) return desc.high || '';
  return desc.mid || '';
}

personaSchema.set('toJSON', { virtuals: true });

export const Persona = mongoose.model<IPersona>('Persona', personaSchema);