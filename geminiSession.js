// geminiSession.js
// THE FILE PETER 1 IMPORTS. DO NOT RENAME. DO NOT CHANGE EXPORTS.
//
// Implements the contractual interface agreed with Peter 1:
//   new GeminiSession(opts)          — constructor
//   session.start()                  — called when call connects
//   session.onAudio(b64)             — called for every audio chunk from caller
//   session.close()                  — called when call ends or is transferred
//   opts.onAudioResponse(b64)        — you call this with Gemini audio output
//   opts.onTransferRequested(num)    — you call this to trigger cold transfer
//   opts.onSessionEnded()            — you call this after clean session close

require('dotenv').config();

// Red Team #6 — Modality enum intentionally NOT imported.
// Use raw string 'AUDIO' to avoid undefined errors across SDK versions.
const { GoogleGenAI } = require('@google/genai');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { tools } = require('./toolDefinitions');
const {
  createSession,
  handleManageOrder,
  collectCustomerDetails,
  handleCompleteOrder,
  deleteSession
} = require('./orderManager');

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TRANSFER_PHRASE = 'TRANSFER_TO_HUMAN';
const TRANSFER_NUMBER = process.env.RESTAURANT_TRANSFER_NUMBER;

class GeminiSession {
  constructor({ callSid, callDbId, onAudioResponse, onTransferRequested, onSessionEnded }) {
    // ── Peter 1's interface contract ──────────────────────────────────────
    this.callSid = callSid;
    this.callDbId = callDbId;
    this.onAudioResponse = onAudioResponse;         // Peter 1 plays this to caller
    this.onTransferRequested = onTransferRequested; // Peter 1 executes cold transfer
    this.onSessionEnded = onSessionEnded;           // Peter 1 cleans up sessions Map

    // ── Internal state ────────────────────────────────────────────────────
    this.session = null;
    this.sessionPromise = null;
    this.isActive = false;

    // Red Team #8 — Buffer audio arriving before Gemini session is ready.
    // Cleared (not flushed) at greeting time — pre-greeting audio is line noise.
    this.pendingAudio = [];

    // Red Team #9 — Persistent transcript across all turns, never reset.
    this.outputTranscript = '';
    this.transferTriggered = false;

    // Order lock — prevents close() from killing session mid-completeOrder.
    this.orderInProgress = false;
  }

  // ── Called by Peter 1 when the call connects ──────────────────────────

  async start() {
    try {
      createSession(this.callSid, this.callDbId);

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      this.sessionPromise = ai.live.connect({
        model: MODEL,
        config: {
          // Red Team #6 — raw string instead of Modality.AUDIO enum
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: SYSTEM_PROMPT,
          tools: tools,
          outputAudioTranscription: {},
          inputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            console.log(`Gemini session open for call: ${this.callSid}`);
            this.isActive = true;

            // Discard pre-greeting audio — it is all line noise from call setup.
            this.pendingAudio = [];

            // Trigger the agent to speak its opening line immediately
            this.sessionPromise.then(session => {
              const hour = new Date().getHours();
              const timeOfDay =
                hour < 12 ? 'morning'
                : hour < 17 ? 'afternoon'
                : 'evening';

              // sendClientContent injects a proper conversation turn that
              // the model must respond to, guaranteeing the greeting fires.
              session.sendClientContent({
                turns: [{
                  role: 'user',
                  parts: [{
                    text: `[CALL_START] Good ${timeOfDay}. Deliver your opening greeting to the caller now.`
                  }]
                }],
                turnComplete: true
              });
            });
          },

          onmessage: async (msg) => {
            await this._handleMessage(msg);
          },

          onclose: (e) => {
            console.log(`Gemini session closed for call: ${this.callSid}`, e?.code);
            this._cleanup();
          },

          
          onerror: (e) => {
            console.error(`Gemini session error for call: ${this.callSid}`, e);
            this._cleanup();
          }
        }
      });

      this.session = await this.sessionPromise;

    } catch (err) {
      console.error('GeminiSession.start() error:', err.message);
      this._cleanup();
    }
  }

  // ── Called by Peter 1 for every audio chunk from the caller ──────────
  // server.js calls this as: session.geminiSession.onAudio(chunk)

  onAudio(base64Pcm16kChunk) {
    // Red Team #8 — Buffer if session not ready yet
    if (!this.isActive || !this.session) {
      this.pendingAudio.push(base64Pcm16kChunk);
      return;
    }
    try {
      // FIX: JS SDK uses audio:{data,mimeType} not media:{mimeType,data}
      this.session.sendRealtimeInput({
        audio: {
          data: base64Pcm16kChunk,
          mimeType: 'audio/pcm;rate=16000'
        }
      });
    } catch (err) {
      // Session may have closed — ignore silently
    }
  }

  // ── Called by Peter 1 when the call ends ─────────────────────────────
  // server.js calls this as: session.geminiSession.close()

  close() {
    if (this.orderInProgress) {
      // Caller hung up during the completeOrder Supabase write window.
      // Defer cleanup by 8s so the DB write finishes.
      console.log(`[${this.callSid}] close() called while order in-flight — deferring cleanup 8s`);
      setTimeout(() => this._cleanup(), 8000);
    } else {
      this._cleanup();
    }
  }

  // ── Internal: handles all incoming Gemini server messages ────────────

  async _handleMessage(msg) {
    if (msg.serverContent?.interrupted) {
      return;
    }

    // FIX: Iterate ALL parts — Gemini may spread audio across multiple parts
    const parts = msg.serverContent?.modelTurn?.parts;
    if (parts && this.onAudioResponse) {
      for (const part of parts) {
        if (part?.inlineData?.data) {
          this.onAudioResponse(part.inlineData.data);
        }
      }
    }

    if (msg.toolCall) {
      await this._handleToolCalls(msg.toolCall.functionCalls);
    }

    // Red Team #9 — accumulate persistently, never reset
    if (msg.serverContent?.outputTranscription?.text) {
      this.outputTranscript += msg.serverContent.outputTranscription.text;
    }

    if (msg.serverContent?.turnComplete) {
      if (!this.transferTriggered && this.outputTranscript.includes(TRANSFER_PHRASE)) {
        this.transferTriggered = true;
        console.log(`Transfer phrase detected on call: ${this.callSid}`);
        if (this.onTransferRequested) {
          this.onTransferRequested(TRANSFER_NUMBER);
        }
      }
      // NOTE: outputTranscript intentionally NOT reset (Red Team #9)
    }
  }

  // ── Internal: handles manageOrder and completeOrder tool calls ────────

  async _handleToolCalls(functionCalls) {
    const responses = [];

    // Snapshot session ref before any awaits — close() may null this.session
    const sessionSnapshot = this.session;

    for (const fc of functionCalls) {
      let result;

      if (fc.name === 'manageOrder') {
        result = handleManageOrder(this.callSid, fc.args);

      } else if (fc.name === 'collectCustomerDetails') {
        result = collectCustomerDetails(this.callSid, fc.args);

      } else if (fc.name === 'completeOrder') {
        this.orderInProgress = true;
        console.log(`[${this.callSid}] completeOrder started — order lock acquired`);

        try {
          result = await handleCompleteOrder(this.callSid, fc.args);
        } finally {
          this.orderInProgress = false;
          console.log(`[${this.callSid}] completeOrder finished — order lock released`);
        }

        // Red Team #10 — 22s for full farewell
        if (result.orderId) {
          setTimeout(() => this._cleanup(), 22000);
        }
      }

      responses.push({
        id: fc.id,
        name: fc.name,
        response: result
      });
    }

    // Use snapshot — this.session may be null if caller hung up during await
    if (sessionSnapshot && responses.length > 0) {
      try {
        sessionSnapshot.sendToolResponse({ functionResponses: responses });
      } catch (err) {
        console.error('sendToolResponse error:', err.message);
      }
    }
  }

  // ── Internal: close Gemini session and clean up state ─────────────────

  _cleanup() {
    if (!this.isActive) return;

    this.isActive = false;
    this.pendingAudio = [];

    if (this.session) {
      try { this.session.close(); } catch (e) {}
      this.session = null;
    }

    deleteSession(this.callSid);

    if (this.onSessionEnded) {
      this.onSessionEnded();
    }

    console.log(`GeminiSession cleaned up for call: ${this.callSid}`);
  }
}

module.exports = GeminiSession;
