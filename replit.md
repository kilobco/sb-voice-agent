# sb-voice-agent

## Overview
A restaurant phone-ordering voice agent that handles inbound Twilio calls, streams audio through Google Gemini AI (for natural language processing), and can interact with Supabase and Clover POS.

## Architecture

### Call Flow
1. Customer calls the restaurant's Twilio number
2. Twilio POSTs to `POST /twiml` on this server
3. Server responds with TwiML XML telling Twilio to open a media-stream WebSocket to `wss://[host]/stream`
4. Twilio connects WebSocket, streams u-law audio
5. `TwilioStream` converts audio -> PCM16, fires `onAudioReady()`
6. Gemini session receives audio, generates AI response
7. AI speech PCM16 -> u-law -> sent back over WebSocket
8. Call ends -> DB updated, session cleaned up

### V2 Fixes Applied
- **Keepalive + 1011 Reconnect**: Periodic keepalive pings prevent idle timeout. On 1011 close, one reconnect attempt is made before teardown.
- **Barge-in (interrupt) fix**: `onClearAudio` callback wired from GeminiSession to `twilioStream.clearAudioBuffer()`. When Gemini detects user speech mid-response, Twilio's audio buffer is flushed immediately.
- **Server-side confirmation gate**: New `confirmOrder` tool enforces that the customer verbally confirmed the order summary before `completeOrder` can proceed. `completeOrder` no longer accepts name/phone as params — reads from session set by `collectCustomerDetails`.
- **Clover production endpoint**: `CLOVER_BASE_URL` env var controls the Clover API base URL (defaults to production).

## Key Files
- `server.js` — Main entry point; Express HTTP + WebSocketServer
- `twilioStream.js` — Handles Twilio media stream WebSocket protocol
- `geminiSession.js` — Google Gemini AI session management (keepalive, reconnect, barge-in)
- `audioBridge.js` — Audio format conversion (u-law <-> PCM16)
- `orderManager.js` — Order logic, cart state, confirmOrder gate
- `supabaseClient.js` — Supabase database client
- `cloverClient.js` — Clover POS integration (env-configurable endpoint)
- `systemPrompt.js` — AI system prompt for the voice agent
- `toolDefinitions.js` — Gemini tool/function definitions (manageOrder, collectCustomerDetails, confirmOrder, completeOrder)

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
- `TWILIO_AUTH_TOKEN` — Twilio auth token
- `GEMINI_API_KEY` — Google Gemini API key
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key
- `DEFAULT_RESTAURANT_ID` — Restaurant ID for order records
- `RESTAURANT_TRANSFER_NUMBER` — E.164 number for human transfer
- `CLOVER_API_TOKEN` — Clover POS API token
- `CLOVER_MERCHANT_ID` — Clover merchant ID
- `CLOVER_BASE_URL` — (optional) Clover API base URL, defaults to `https://api.clover.com/v3`
- `PORT` — (optional) server port, defaults to 8080

## Tool Call Sequence (Enforced Server-Side)
1. `manageOrder` — add/remove items (repeatable)
2. `collectCustomerDetails` — name + phone (required before confirm)
3. `confirmOrder` — customer said yes (required before complete)
4. `completeOrder` — writes to Supabase + Clover (no params, reads session)

## Workflow
- **Start application**: `node server.js` — runs the backend server (console output, port 8080)

## Deployment
- Target: VM (always running — maintains WebSocket state)
- Run: `node server.js`
