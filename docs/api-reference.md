# API Reference

> Complete reference for all AI Bestie REST endpoints.

## Base URL

```
Development: http://localhost:3001/api
Production:   https://api.aibestie.com/api
```

## Authentication

All endpoints except `/auth/register` and `/auth/login` require a valid JWT cookie.

```
Cookie: token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Unauthorized response:**
```json
{ "success": false, "message": "Authentication required" }
```

**Rate limits:**
- Auth routes: 5 requests per 10 minutes per IP
- API routes: 10 requests per 10 seconds per user

---

## Auth Routes

### POST /api/auth/register

Create a new account.

**Request:**
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "securepassword123"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "64f1a2b3c4d5e6f7a8b9c0d1",
      "name": "Jane Doe",
      "email": "jane@example.com"
    }
  }
}
```

**Error (409):**
```json
{
  "success": false,
  "message": "Email already registered"
}
```

**Error (400) — Validation:**
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": {
    "email": "Invalid email",
    "password": "Password must be at least 8 characters"
  }
}
```

Sets `token` HTTP-only cookie on success.

---

### POST /api/auth/login

Authenticate an existing user.

**Request:**
```json
{
  "email": "jane@example.com",
  "password": "securepassword123"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "64f1a2b3c4d5e6f7a8b9c0d1",
      "name": "Jane Doe",
      "email": "jane@example.com"
    }
  }
}
```

**Error (401):**
```json
{ "success": false, "message": "Invalid email or password" }
```

Sets `token` HTTP-only cookie on success.

---

### POST /api/auth/logout

Clear the authentication cookie.

**Response (200):**
```json
{ "success": true, "message": "Logged out successfully" }
```

---

### GET /api/auth/me

Get the currently authenticated user.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "64f1a2b3c4d5e6f7a8b9c0d1",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "activePersonaId": "64f2a3b4c5d6e7f8a9b0c1d2"
    }
  }
}
```

---

## Avatar Routes

### GET /api/avatars

List all avatars, optionally filtered by category.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `category` | string | Filter: `mentor`, `friend`, `therapist`, `coach` |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "avatars": [
      {
        "id": "mentor-male-01",
        "name": "Marcus",
        "src": "/avatars/mentor-male-01.svg",
        "category": "mentor"
      }
    ]
  }
}
```

---

### GET /api/avatars/:id

Get a single avatar by ID.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "avatar": {
      "id": "mentor-male-01",
      "name": "Marcus",
      "src": "/avatars/mentor-male-01.svg",
      "category": "mentor"
    }
  }
}
```

**Error (404):**
```json
{ "success": false, "message": "Avatar not found" }
```

---

## Persona Routes

All persona routes require authentication.

### GET /api/personas/archetypes

Get all available archetype configurations.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "archetypes": [
      {
        "type": "mentor",
        "displayName": "The Mentor",
        "corePurpose": "Guide, challenge, and inspire through wisdom...",
        "voiceStyle": "Calm authority. Uses analogies...",
        "defaultTraits": { "directness": 7, "warmth": 6, "proactivity": 7, "depth": 8, "accountability": 7 },
        "traitRanges": {
          "directness": { "min": 5, "max": 9 },
          "warmth": { "min": 4, "max": 8 },
          "proactivity": { "min": 5, "max": 9 },
          "depth": { "min": 6, "max": 10 },
          "accountability": { "min": 5, "max": 9 }
        }
      }
    ]
  }
}
```

---

### GET /api/personas

List the authenticated user's personas.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "personas": [
      {
        "id": "64f2a3b4c5d6e7f8a9b0c1d2",
        "name": "Atlas",
        "archetype": "mentor",
        "avatarId": "mentor-male-01",
        "traits": { "directness": 7, "warmth": 6, "proactivity": 7, "depth": 8, "accountability": 7 },
        "createdAt": "2024-01-15T10:30:00Z"
      }
    ]
  }
}
```

---

### POST /api/personas

Create a new persona.

**Request:**
```json
{
  "name": "Atlas",
  "archetype": "mentor",
  "avatarId": "mentor-male-01",
  "traits": {
    "directness": 8,
    "warmth": 5,
    "proactivity": 7,
    "depth": 9,
    "accountability": 7
  }
}
```

Traits outside the archetype's range are automatically clamped on save.

**Response (201):**
```json
{
  "success": true,
  "data": {
    "persona": {
      "id": "64f2a3b4c5d6e7f8a9b0c1d2",
      "name": "Atlas",
      "archetype": "mentor",
      "avatarId": "mentor-male-01",
      "traits": { "directness": 8, "warmth": 5, "proactivity": 7, "depth": 9, "accountability": 7 },
      "createdAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

---

### GET /api/personas/:id

Get a single persona.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "persona": {
      "id": "64f2a3b4c5d6e7f8a9b0c1d2",
      "name": "Atlas",
      "archetype": "mentor",
      "avatarId": "mentor-male-01",
      "traits": { "directness": 8, "warmth": 5, "proactivity": 7, "depth": 9, "accountability": 7 }
    }
  }
}
```

---

### PATCH /api/personas/:id

Update a persona's name, avatar, or traits. Traits are clamped to archetype ranges.

**Request:**
```json
{
  "traits": { "directness": 9, "warmth": 3 }
}
```

**Response (200):** Returns the updated persona with clamped traits.

---

### DELETE /api/personas/:id

Delete a persona.

**Response (200):**
```json
{ "success": true, "message": "Persona deleted" }
```

---

## Conversation Routes

All conversation routes require authentication.

### GET /api/conversations

List the authenticated user's conversations, sorted by most recent.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "conversations": [
      {
        "id": "64f3a4b5c6d7e8f9a0b1c2d3",
        "title": "Career Advice",
        "personaId": "64f2a3b4c5d6e7f8a9b0c1d2",
        "avatarId": "mentor-male-01",
        "lastMessageAt": "2024-01-15T12:00:00Z",
        "createdAt": "2024-01-15T10:30:00Z"
      }
    ]
  }
}
```

---

### POST /api/conversations

Create a new conversation.

**Request:**
```json
{
  "personaId": "64f2a3b4c5d6e7f8a9b0c1d2",
  "avatarId": "mentor-male-01",
  "title": "Career Advice"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "conversation": {
      "id": "64f3a4b5c6d7e8f9a0b1c2d3",
      "title": "Career Advice",
      "personaId": "64f2a3b4c5d6e7f8a9b0c1d2",
      "avatarId": "mentor-male-01",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

---

### GET /api/conversations/:id

Get a conversation with all messages.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "conversation": {
      "id": "64f3a4b5c6d7e8f9a0b1c2d3",
      "title": "Career Advice",
      "personaId": "64f2a3b4c5d6e7f8a9b0c1d2",
      "avatarId": "mentor-male-01",
      "messages": [
        {
          "role": "user",
          "content": "I'm thinking about changing careers",
          "timestamp": "2024-01-15T10:31:00Z"
        },
        {
          "role": "assistant",
          "content": "That's a big decision. What's driving this thought?",
          "timestamp": "2024-01-15T10:31:05Z",
          "tokenCount": 12
        }
      ],
      "createdAt": "2024-01-15T10:30:00Z",
      "lastMessageAt": "2024-01-15T10:31:05Z"
    }
  }
}
```

---

### POST /api/conversations/:id/messages/stream

Send a message and receive a streaming response via Server-Sent Events.

**Request:**
```json
{
  "message": "I'm thinking about changing careers"
}
```

**Response:** `Content-Type: text/event-stream`

SSE events in order:
```
data: {"type":"state","state":"thinking"}

data: {"type":"state","state":"speaking"}

data: {"type":"token","content":"That"}
data: {"type":"token","content":"'s"}
data: {"type":"token","content":" a"}
data: {"type":"token","content":" big"}
data: {"type":"token","content":" decision"}
data: {"type":"token","content":"."}

data: {"type":"state","state":"idle"}
data: {"type":"done","messageId":"msg_1705312265000"}
```

**Error events:**
```
data: {"type":"error","message":"Failed to generate response"}
```

---

### DELETE /api/conversations/:id

Delete a conversation.

**Response (200):**
```json
{ "success": true, "message": "Conversation deleted" }
```

**Error (404):**
```json
{ "success": false, "message": "Conversation not found" }
```

---

## Error Response Format

All errors follow this structure:

```json
{
  "success": false,
  "message": "Human-readable error description",
  "errors": {
    "fieldName": "Specific validation message"
  }
}
```

| Status | When |
|--------|------|
| 400 | Zod validation failure, Mongoose validation error |
| 401 | Missing/invalid JWT, expired token |
| 404 | Resource not found |
| 409 | Duplicate email on register |
| 429 | Rate limit exceeded |
| 500 | Unexpected server error |
