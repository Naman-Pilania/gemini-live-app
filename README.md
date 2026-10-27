# Gemini Live voice call (React + Node)

Browser mic <-> Node WebSocket relay <-> Gemini Live API. The API key lives only in `server/.env`.

## Setup
1. Get a free key from Google AI Studio.
2. `cp server/.env.example server/.env` and paste your key.
3. `npm run install:all`
4. `npm run dev`
5. Open http://localhost:5173 (Chrome or Edge), click Start call, allow the mic.

## Structure
- `server/index.js`: Express + `ws` relay. Builds the Gemini setup message (model, voice, system prompt) from the browser's config.
- `client/src/useLiveCall.js`: mic capture, playback, interruptions, transcripts.
- `client/public/capture-worklet.js`: resamples mic audio to 16 kHz PCM16.

## Troubleshooting
- "Gemini closed the session (...)": check the key and the model name (preview names change; see Google's Live API docs).
- Closes right after connecting: free-tier rate limit, or untick "Agent speaks first".
- Use Node 18+.
