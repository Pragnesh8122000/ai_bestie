import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export type AuthProvider = 'password' | 'google';

export interface IUser extends Document {
  email: string;
  password?: string;
  name: string;
  authProviders: AuthProvider[];
  googleSubject?: string;
  activePersonaId?: mongoose.Types.ObjectId;
  preferences: {
    theme: 'light' | 'dark' | 'system';
    notifications: boolean;
  };
  createdAt: Date;
  lastLoginAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      select: false,
      minlength: 8,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    authProviders: {
      type: [{ type: String, enum: ['password', 'google'] }],
      default: ['password'],
      validate: {
        validator: (providers: AuthProvider[]) => providers.length > 0,
        message: 'At least one authentication provider is required',
      },
    },
    googleSubject: {
      type: String,
      trim: true,
    },
    activePersonaId: {
      type: Schema.Types.ObjectId,
      ref: 'Persona',
    },
    preferences: {
      theme: {
        type: String,
        enum: ['light', 'dark', 'system'],
        default: 'system',
      },
      notifications: {
        type: Boolean,
        default: true,
      },
    },
    lastLoginAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// A Google subject (`sub`) is stable and never reused, unlike an email
// address. The partial index lets password-only users omit the field while
// guaranteeing that one Google identity can never be attached twice.
userSchema.index(
  { googleSubject: 1 },
  {
    unique: true,
    partialFilterExpression: { googleSubject: { $type: 'string' } },
  },
);

userSchema.pre('validate', function (next) {
  const providers = this.authProviders || [];
  if (this.isNew && providers.includes('password') && !this.password) {
    this.invalidate('password', 'Password is required for password authentication');
  }
  if (this.isNew && providers.includes('google') && !this.googleSubject) {
    this.invalidate('googleSubject', 'Google subject is required for Google authentication');
  }
  next();
});

// Pre-save hook for password hashing
userSchema.pre('save', async function (next) {
  if (!this.password || !this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to compare password
userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  if (!this.password || !this.authProviders.includes('password')) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Virtual for string id
userSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

userSchema.set('toJSON', { virtuals: true });

export const User = mongoose.model<IUser>('User', userSchema);
