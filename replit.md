# sb-voice-agent

## Overview
A restaurant phone-ordering voice agent that handles inbound Twilio calls, streams audio through Google Gemini AI (for natural language processing), and can interact with Supabase and Clover POS.

## Architecture

### Call Flow
1. Customer calls the restaurant's Twilio number
2. Twilio POSTs to `POST /twiml` on this server
3. Server responds with TwiML XML telling Twilio to open a media-stream WebSocket to `wss://[host]/stream`
4. Twilio connects WebSocket, streams µ-law audio
5. `TwilioStream` converts audio → PCM16, fires `onAudioReady()`
6. Gemini session receives audio, generates AI response
7. AI speech PCM16 → µ-law → sent back over WebSocket
8. Call ends → DB updated, session cleaned up

## Key Files
- `server.js` — Main entry point; Express HTTP + WebSocketServer
- `twilioStream.js` — Handles Twilio media stream WebSocket protocol
- `geminiSession.js` — Google Gemini AI session management
- `audioBridge.js` — Audio format conversion (µ-law ↔ PCM16)
- `orderManager.js` — Order logic and management
- `supabaseClient.js` — Supabase database client
- `cloverClient.js` — Clover POS integration
- `systemPrompt.js` — AI system prompt for the voice agent
- `toolDefinitions.js` — Gemini tool/function definitions

## Tech Stack
- **Runtime**: Node.js 20
- **Framework**: Express 5
- **WebSockets**: ws
- **AI**: Google Gemini (@google/genai, @google/generative-ai)
- **Telephony**: Twilio
- **Database**: Supabase (@supabase/supabase-js)

## Server
- Runs on port `8080` (configurable via `PORT` env var)
- Endpoints:
  - `GET /health` — health check
  - `POST /twiml` — Twilio webhook
  - `wss://[host]/stream` — Twilio media stream WebSocket

## Required Environment Variables
- `TWILIO_ACCOUNT_SID` — Twilio account SID
- `GEMINI_API_KEY` — Google Gemini API key
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anonymous key
- `PORT` — (optional) server port, defaults to 8080

## Workflow
- **Start application**: `node server.js` — runs the backend server (console output, port 8080)

## Deployment
- Target: VM (always running — maintains WebSocket state)
- Run: `node server.js`
