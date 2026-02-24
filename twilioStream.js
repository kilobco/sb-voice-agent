// twilioStream.js
//
// Handles the Twilio Media Streams WebSocket lifecycle for a single phone call.
//
// Twilio sends three event types over the WebSocket:
//   'start'  → call connected, metadata available (callSid, streamSid, phone numbers)
//   'media'  → a chunk of µ-law audio from the caller (base64 encoded)
//   'stop'   → call ended on Twilio's side
//
// This class:
//   • Converts Twilio µ-law audio ↔ PCM16 for Gemini (via audioBridge)
//   • Writes call records to Supabase (via supabaseClient)
//   • Fires callbacks so the Gemini session layer (Peter 3) can react
//   • Sends Gemini's synthesised speech back to the caller over the same WebSocket
//   • Handles cold transfers to human agents

'use strict';

const { twilioAudioToGemini, geminiAudioToTwilio } = require('./audioBridge');
const {
  createCallRecord,
  completeCallRecord,
  escalateCallRecord,
  failCallRecord,
} = require('./supabaseClient');

// WebSocket readyState constants (matches the ws library and browser WebSocket)
const WS_OPEN = 1;

class TwilioStream {
  /**
   * @param {WebSocket}  ws               - WebSocket connection from Twilio
   * @param {Function}   onAudioReady     - Called with base64 PCM16 chunk for Gemini
   * @param {Function}   onCallStarted    - Called with (callSid, callDbId) when 'start' arrives
   * @param {Function}   onCallEnded      - Called with (callSid) when the call is fully closed
   * @param {object}     [deps]           - Optional dependency overrides (for testing)
   * @param {Function}   [deps.twilioFactory] - Replaces require('twilio') for unit tests
   */
  constructor(ws, onAudioReady, onCallStarted, onCallEnded, deps = {}) {
    // ── WebSocket ────────────────────────────────────────────────────────────
    this.ws = ws;

    // ── Call state (populated on 'start') ────────────────────────────────────
    this.streamSid       = null;
    this.callSid         = null;
    this.callerPhone     = null;
    this.restaurantPhone = null;
    this.callDbRecord    = null;   // Supabase calls row
    this.startedAt       = null;

    // ── Lifecycle flags ───────────────────────────────────────────────────────
    this.isStarted  = false;  // true after 'start' event processed
    this.isClosed   = false;  // guards against double-close (stop + ws.close race)
    this.isTransfer = false;  // true when executeTransfer() has been called

    // ── Callbacks ─────────────────────────────────────────────────────────────
    this.onAudioReady  = onAudioReady  || null;
    this.onCallStarted = onCallStarted || null;
    this.onCallEnded   = onCallEnded   || null;

    // ── Dependency injection (makes the class fully testable without Twilio SDK) ─
    this._twilioFactory = deps.twilioFactory || null;

    // ── Wire up WebSocket events ──────────────────────────────────────────────
    this.ws.on('message', (data) => this._handleMessage(data));
    this.ws.on('close',   ()     => this._handleClose('ws_close'));
    this.ws.on('error',   (err)  => this._handleWsError(err));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — inbound message handling
  // ═══════════════════════════════════════════════════════════════════════════

  async _handleMessage(rawData) {
    // Parse errors must NEVER crash the WebSocket handler permanently.
    // A single bad message should be discarded; the stream continues.
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch (e) {
      console.warn('[TwilioStream] Received non-JSON message — ignoring:', String(rawData).slice(0, 80));
      return;
    }

    try {
      switch (msg.event) {
        case 'start':  await this._onStart(msg);  break;
        case 'media':        this._onMedia(msg);  break;
        case 'stop':   await this._onStop(msg);   break;
        default:
          // Twilio may send 'connected', 'dtmf', or future event types — just log
          console.debug('[TwilioStream] Unhandled event type:', msg.event);
      }
    } catch (err) {
      console.error(`[TwilioStream] Error handling event "${msg.event}":`, err.message);
    }
  }

  async _onStart(msg) {
    this.streamSid       = msg.start?.streamSid   || null;
    this.callSid         = msg.start?.callSid      || null;
    this.callerPhone     = msg.start?.customParameters?.callerPhone     || 'unknown';
    this.restaurantPhone = msg.start?.customParameters?.restaurantPhone || 'unknown';
    this.startedAt       = new Date().toISOString();
    this.isStarted       = true;

    if (this.callerPhone     === 'unknown') console.warn('[TwilioStream] callerPhone not provided in customParameters');
    if (this.restaurantPhone === 'unknown') console.warn('[TwilioStream] restaurantPhone not provided in customParameters');

    console.log(`[TwilioStream] Call started: ${this.callSid} | caller: ${this.callerPhone}`);

    // Write call record to Supabase — failure is non-fatal, call continues
    try {
      this.callDbRecord = await createCallRecord(
        this.callSid, this.streamSid, this.callerPhone, this.restaurantPhone
      );
    } catch (err) {
      console.error('[TwilioStream] Failed to write call record to DB:', err.message);
    }

    // Notify Gemini session layer
    if (this.onCallStarted) {
      try {
        this.onCallStarted(this.callSid, this.callDbRecord?.id || null);
      } catch (err) {
        console.error('[TwilioStream] onCallStarted callback threw:', err.message);
      }
    }
  }

  _onMedia(msg) {
    // Skip media before 'start' (rare race condition: Twilio can queue media
    // before our handler processes the 'start' event)
    if (!this.isStarted) return;

    const payload = msg.media?.payload;
    if (!payload) {
      console.warn('[TwilioStream] media event missing payload — skipping');
      return;
    }

    try {
      const geminiAudio = twilioAudioToGemini(payload);
      if (this.onAudioReady) this.onAudioReady(geminiAudio);
    } catch (err) {
      console.error('[TwilioStream] Audio conversion (Twilio→Gemini) failed:', err.message);
    }
  }

  async _onStop(msg) {
    console.log(`[TwilioStream] Call stopped: ${this.callSid}`);
    await this._handleClose('stop_event');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — close & error handling
  // ═══════════════════════════════════════════════════════════════════════════

  async _handleClose(source) {
    // ── Double-close guard ───────────────────────────────────────────────────
    // 'stop' event AND the WebSocket 'close' event BOTH fire on a normal hang-up.
    // Without this flag, completeCallRecord() would fire twice and onCallEnded
    // would notify Peter 3 twice.
    if (this.isClosed) return;
    this.isClosed = true;

    console.log(`[TwilioStream] Closing call (source: ${source}): ${this.callSid}`);

    // Only attempt DB updates if 'start' was processed (callSid is available).
    // If Twilio closes before sending 'start' (instant hang-up), skip the DB write.
    if (this.isStarted && this.callSid) {
      try {
        if (this.isTransfer) {
          // escalateCallRecord was already written inside executeTransfer
        } else if (source === 'ws_error') {
          await failCallRecord(this.callSid, 'WebSocket closed unexpectedly');
        } else {
          await completeCallRecord(this.callSid, this.startedAt);
        }
      } catch (err) {
        console.error('[TwilioStream] Failed to update call record on close:', err.message);
      }
    }

    // Notify Gemini session layer
    if (this.onCallEnded) {
      try {
        this.onCallEnded(this.callSid);
      } catch (err) {
        console.error('[TwilioStream] onCallEnded callback threw:', err.message);
      }
    }
  }

  _handleWsError(err) {
    console.error('[TwilioStream] WebSocket error:', err.message);
    // The 'close' event always fires after an error — _handleClose() will run then.
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC — outbound audio to caller
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a chunk of Gemini-generated PCM16 audio back to the caller.
   * Called by the Gemini session layer (Peter 3) during TTS playback.
   *
   * @param {string} base64Pcm24kChunk - base64-encoded PCM16 at 24 kHz from Gemini
   */
  sendAudioToCaller(base64Pcm24kChunk) {
    if (this.ws.readyState !== WS_OPEN) {
      console.warn('[TwilioStream] sendAudioToCaller: WebSocket not open, skipping chunk');
      return;
    }

    let mulawAudio;
    try {
      mulawAudio = geminiAudioToTwilio(base64Pcm24kChunk);
    } catch (err) {
      console.error('[TwilioStream] Audio conversion (Gemini→Twilio) failed:', err.message);
      return;
    }

    try {
      this.ws.send(JSON.stringify({
        event:     'media',
        streamSid: this.streamSid,
        media:     { payload: mulawAudio },
      }));
    } catch (err) {
      // ws can throw synchronously if the socket transitions to CLOSING between
      // the readyState check and the actual send() call.
      console.error('[TwilioStream] ws.send() failed:', err.message);
    }
  }

  /**
   * Send a "clear" message to Twilio to flush any buffered audio mid-stream.
   * Call this when the user interrupts Gemini's speech (barge-in detection).
   */
  clearAudioBuffer() {
    if (this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    } catch (err) {
      console.error('[TwilioStream] clearAudioBuffer ws.send() failed:', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC — cold transfer to human agent
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Cold-transfer the live call to a human agent via Twilio's REST API.
   * Marks the call as escalated in Supabase.
   *
   * @param {string} transferNumber - E.164 number to transfer to (e.g. +15551234567)
   * @throws if the Twilio REST API call fails
   */
  async executeTransfer(transferNumber) {
    if (!transferNumber) throw new TypeError('executeTransfer: transferNumber is required');
    if (!this.callSid)   throw new Error('executeTransfer: call has not started yet');
    if (this.isClosed)   throw new Error('executeTransfer: call is already closed');

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      throw new Error('executeTransfer: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env vars missing');
    }

    // Set flag BEFORE async work so no concurrent path tries to completeCallRecord
    this.isTransfer = true;

    try {
      // Use injected factory if provided (for tests), otherwise load the real SDK
      const createTwilioClient = this._twilioFactory || require('twilio');
      const client = createTwilioClient(accountSid, authToken);
      await client.calls(this.callSid).update({
        twiml: `<Response><Dial>${transferNumber}</Dial></Response>`,
      });
    } catch (err) {
      // REST call failed — roll back so the call can still end normally
      this.isTransfer = false;
      throw new Error(`executeTransfer: Twilio API call failed — ${err.message}`);
    }

    try {
      await escalateCallRecord(this.callSid);
    } catch (err) {
      // Transfer already happened — DB failure is non-fatal, log and continue
      console.error('[TwilioStream] executeTransfer: failed to write escalation to DB:', err.message);
    }

    console.log(`[TwilioStream] Call ${this.callSid} transferred to ${transferNumber}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC — accessors
  // ═══════════════════════════════════════════════════════════════════════════

  /** The Supabase calls.id for this call (null until 'start' + DB write succeed) */
  get callId()   { return this.callDbRecord?.id || null; }

  /** True while the call is connected and not yet closing */
  get isActive() { return this.isStarted && !this.isClosed; }
}

module.exports = TwilioStream;