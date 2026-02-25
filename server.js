// server.js
//
// Main entry point for the restaurant phone-ordering system.
//
// Architecture overview:
// ┌─────────────────────────────────────────────────────────────────────┐
// │  INBOUND CALL FLOW                                                   │
// │                                                                      │
// │  1. Customer calls restaurant number (Twilio receives it)            │
// │  2. Twilio POSTs to POST /twiml on this server                       │
// │  3. Server responds with TwiML XML telling Twilio to open a          │
// │     media-stream WebSocket to wss://[host]/stream                    │
// │  4. Twilio connects WebSocket, starts streaming µ-law audio          │
// │  5. TwilioStream converts audio → PCM16, fires onAudioReady()        │
// │  6. Gemini session (Peter 3) receives audio, generates AI response   │
// │  7. AI speech PCM16 → µ-law → sent back over same WebSocket         │
// │  8. Call ends → DB updated, session cleaned up                       │
// └─────────────────────────────────────────────────────────────────────┘
//
// Key objects:
//   sessions  Map<callSid, SessionEntry>  all live calls tracked here
//   app       Express HTTP server         handles /health and /twiml
//   wss       WebSocketServer             handles /stream (Twilio audio)
//
// For Peter 3 (Gemini layer): call server.setGeminiHandlers(factory) BEFORE
// starting the server, or inject via the GEMINI_HANDLERS_MODULE env var.

'use strict';

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const TwilioStream = require('./twilioStream');

// ─── Session registry ─────────────────────────────────────────────────────────
// Keyed by Twilio callSid (known only after the 'start' event).
// Each entry: { stream: TwilioStream, callDbId: string|null, geminiSession: any }
const sessions = new Map();

// ─── Gemini handler factory (injected by Peter 3) ─────────────────────────────
// Factory signature: (callSid, callDbId) => GeminiSession
// GeminiSession must expose: onAudio(base64PcmChunk), close()
let _geminiHandlerFactory = null;

/**
 * Register Gemini session factory. Call this before server.listen().
 * Peter 3 calls this to wire their AI session into every new call.
 *
 * @param {Function} factory  (callSid, callDbId, twilioStream) => GeminiSession
 *   GeminiSession must expose:
 *     .onAudio(base64Pcm16Chunk)  — called with each caller audio chunk
 *     .close()                    — called when the call ends
 */
function setGeminiHandlers(factory) {
  if (typeof factory !== 'function') {
    throw new TypeError('setGeminiHandlers: factory must be a function');
  }
  _geminiHandlerFactory = factory;
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
// Render, Railway, and other PaaS platforms poll this to verify the server is up.
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: sessions.size,
  });
});

// ── TwiML webhook — called by Twilio when someone dials the restaurant number ──
// Twilio POSTs application/x-www-form-urlencoded with at minimum:
//   From  — caller's E.164 phone number
//   To    — the Twilio number that was dialled (restaurant number)
//   CallSid — Twilio's call identifier
app.post('/twiml', (req, res) => {
  const host = req.headers.host;
  const callerPhone = sanitizePhone(req.body?.From || '');
  const restaurantPhone = sanitizePhone(req.body?.To || '');

  if (!host) {
    console.error('[server] /twiml: missing Host header');
    return res.status(400).send('Bad Request');
  }

  // Build the TwiML that tells Twilio to:
  //   1. Keep the call open (Connect)
  //   2. Stream the audio to our WebSocket endpoint
  //   3. Pass the phone numbers as custom parameters so TwilioStream can read them
  const twiml = buildTwiml(host, callerPhone, restaurantPhone);

  console.log(`[server] /twiml: incoming call from ${callerPhone} to ${restaurantPhone}`);
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  const remoteAddr = req.socket.remoteAddress;
  console.log(`[server] New Twilio WebSocket connection from ${remoteAddr}`);

  // ── onAudioReady — raw caller PCM16 chunk ready for Gemini ────────────────
  // Called many times per second during a live call.
  const onAudioReady = (base64Pcm16Chunk) => {
    if (!stream.callSid) return; // 'start' not yet processed
    const session = sessions.get(stream.callSid);
    if (session?.geminiSession) {
      try {
        session.geminiSession.onAudio(base64Pcm16Chunk);
      } catch (err) {
        console.error(`[server] geminiSession.onAudio threw for ${stream.callSid}:`, err.message);
      }
    }
  };

  // ── onCallStarted — 'start' event processed, DB record written ────────────
  // This is when we move the session into the Map and spin up Gemini.
  const onCallStarted = (callSid, callDbId) => {
    console.log(`[server] Call started: ${callSid} | DB id: ${callDbId}`);

    // Create the session entry so onAudioReady can find it
    const entry = { stream, callDbId, geminiSession: null };
    sessions.set(callSid, entry);

    // Spin up the Gemini session if a factory has been registered
    if (_geminiHandlerFactory) {
      try {
        entry.geminiSession = _geminiHandlerFactory(callSid, callDbId, stream);
        console.log(`[server] Gemini session created for ${callSid}`);
      } catch (err) {
        console.error(`[server] Failed to create Gemini session for ${callSid}:`, err.message);
      }
    } else {
      console.warn(`[server] No Gemini handler registered — audio will not be processed for ${callSid}`);
    }
  };

  // ── onCallEnded — call finished, clean up everything ─────────────────────
  const onCallEnded = (callSid) => {
    console.log(`[server] Call ended: ${callSid}`);

    const session = callSid ? sessions.get(callSid) : null;
    if (session?.geminiSession) {
      try {
        session.geminiSession.close();
      } catch (err) {
        console.error(`[server] geminiSession.close threw for ${callSid}:`, err.message);
      }
    }

    if (callSid) sessions.delete(callSid);
    console.log(`[server] Active sessions: ${sessions.size}`);
  };

  // Create the stream handler — this wires all three WS events (message/close/error)
  const stream = new TwilioStream(ws, onAudioReady, onCallStarted, onCallEnded);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Render/Railway send SIGTERM before killing the process.
// We stop accepting new connections, then give active calls up to 30 s to finish.
function shutdown(signal) {
  console.log(`\n[server] Received ${signal} — shutting down gracefully...`);

  // Stop accepting new HTTP + WebSocket connections
  server.close(() => {
    console.log('[server] HTTP server closed');
  });

  // Close all active WebSocket connections (triggers TwilioStream.handleClose)
  wss.clients.forEach((ws) => {
    try { ws.terminate(); } catch (_) { }
  });

  // Force-exit after 30 s if graceful close hangs
  const forceExit = setTimeout(() => {
    console.error('[server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000);
  forceExit.unref(); // don't keep the event loop alive for this timer
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitize a phone number before embedding it in XML.
 * Strips any characters that are not digits, +, (, ), -, space.
 * Falls back to 'unknown' if the result is empty.
 *
 * This prevents TwiML-injection attacks where a malicious caller
 * could craft a From header containing XML tags.
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizePhone(raw) {
  if (typeof raw !== 'string') return 'unknown';
  // Keep only valid phone number characters
  const cleaned = raw.replace(/[^0-9+\-()\s]/g, '').trim();
  return cleaned || 'unknown';
}

/**
 * Build the TwiML response body.
 * Separated from the route handler so it can be unit-tested in isolation.
 *
 * @param {string} host            - HTTP Host header (e.g. "myapp.onrender.com")
 * @param {string} callerPhone     - sanitized caller E.164 number
 * @param {string} restaurantPhone - sanitized restaurant E.164 number
 * @returns {string}               - complete TwiML XML document
 */
function buildTwiml(host, callerPhone, restaurantPhone) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/stream">
      <Parameter name="callerPhone" value="${callerPhone}" />
      <Parameter name="restaurantPhone" value="${restaurantPhone}" />
    </Stream>
  </Connect>
</Response>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);

// Only auto-start when run directly (not when required by tests)
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[server] Running on port ${PORT}`);
    console.log(`[server] TwiML endpoint : POST /twiml`);
    console.log(`[server] Stream endpoint: wss://[host]/stream`);
    console.log(`[server] Health check   : GET /health`);

    if (!process.env.TWILIO_ACCOUNT_SID) console.warn('[server] WARNING: TWILIO_ACCOUNT_SID not set');
    if (!process.env.GEMINI_API_KEY) console.warn('[server] WARNING: GEMINI_API_KEY not set');
    if (!process.env.SUPABASE_URL) console.warn('[server] WARNING: SUPABASE_URL not set');
  });
}

// ── Wire Peter 3's Gemini session into the call factory ──────────────
const GeminiSession = require('./geminiSession');

setGeminiHandlers((callSid, callDbId, twilioStream) => {
  const session = new GeminiSession({
    callSid,
    callDbId,
    onAudioResponse: (chunk) => twilioStream.sendAudioToCaller(chunk),
    onTransferRequested: (number) => twilioStream.executeTransfer(number),
    onSessionEnded: () => { }
  });
  session.start();
  return session;
});

// ─── Exports (used by tests and Peter 3) ─────────────────────────────────────
module.exports = {
  app,           // Express app — for supertest / HTTP testing
  server,        // http.Server — for server.listen() / server.close()
  wss,           // WebSocketServer — for connection count inspection
  sessions,      // Live session Map — Peter 3 can look up streams by callSid
  setGeminiHandlers,  // Peter 3 calls this to inject AI session factory
  // Exported for unit testing
  _buildTwiml: buildTwiml,
  _sanitizePhone: sanitizePhone,
  _shutdown: shutdown,
};