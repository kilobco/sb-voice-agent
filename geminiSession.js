// geminiSession.js
// THE FILE PETER 1 IMPORTS. DO NOT RENAME. DO NOT CHANGE EXPORTS.
//
// Implements the contractual interface agreed with Peter 1:
//   new GeminiSession(opts)          — constructor
//   session.start()                  — called when call connects
//   session.receiveAudio(b64)        — called for every audio chunk from caller
//   session.stop()                   — called when call ends or is transferred
//   opts.onAudioResponse(b64)        — you call this with Gemini audio output
//   opts.onTransferRequested(num)    — you call this to trigger cold transfer
//   opts.onSessionEnded()            — you call this after clean session close

require('dotenv').config();

// NOTE: Modality enum intentionally NOT imported — use raw string 'AUDIO'
// to avoid enum undefined errors across SDK versions (Red Team #6)
const { GoogleGenAI } = require('@google/genai');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { tools } = require('./toolDefinitions');
const {
  createSession,
  handleManageOrder,
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
    // Cleared (not flushed) at greeting time — inbound call audio before the
    // greeting is silence/line noise, not meaningful caller speech. Caller
    // words only arrive AFTER they hear the greeting.
    this.pendingAudio = [];

    // Red Team #9 — Persistent transcript, never reset between turns.
    this.outputTranscript = '';
    this.transferTriggered = false;
  }

  // ── Called by Peter 1 when the call connects ──────────────────────────

  async start() {
    try {
      createSession(this.callSid, this.callDbId);

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      this.sessionPromise = ai.live.connect({
        model: MODEL,
        config: {
          // Red Team #6 — raw string, not Modality enum
          responseModalities: ['AUDIO'],

          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },

          systemInstruction: SYSTEM_PROMPT,
          tools: tools,
          outputAudioTranscription: {},
          inputAudioTranscription: {},

          // ── FIX: Noise / barge-in ──────────────────────────────────────
          // Phone lines carry constant background noise. Default VAD is too
          // sensitive and triggers on that noise, interrupting the agent
          // mid-sentence. Lower sensitivity + longer silence threshold prevents
          // this without making the agent unresponsive to real speech.
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
              endOfSpeechSensitivity:   'END_SENSITIVITY_LOW',
              prefixPaddingMs:  500,   // Require 500ms of speech before triggering
              silenceDurationMs: 2000  // Wait 2s of silence before ending a turn
            }
          }
        },

        callbacks: {
          onopen: () => {
            console.log(`Gemini session open for call: ${this.callSid}`);
            this.isActive = true;

            // Discard pre-greeting audio — it is all line noise from call setup.
            // Real caller words only come after they hear the greeting.
            this.pendingAudio = [];

            this.sessionPromise.then(session => {
              const hour = new Date().getHours();
              const timeOfDay =
                hour < 12 ? 'morning'
                : hour < 17 ? 'afternoon'
                : 'evening';

              // ── FIX: Greeting ────────────────────────────────────────────
              // sendRealtimeInput({text}) does NOT reliably trigger audio
              // output from the native audio model — it processes streaming
              // media, not conversation turns.
              //
              // sendClientContent() injects a proper conversation turn that
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

  receiveAudio(base64Pcm16kChunk) {
    // Buffer if session not ready yet (Red Team #8).
    // These chunks are cleared at onopen — see above.
    if (!this.isActive || !this.session) {
      this.pendingAudio.push(base64Pcm16kChunk);
      return;
    }
    try {
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

  stop() {
    this._cleanup();
  }

  // ── Internal: handles all incoming Gemini server messages ────────────

  async _handleMessage(msg) {
    if (msg.serverContent?.interrupted) {
      return;
    }

    // Forward all audio parts to Peter 1
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
    }
  }

  // ── Internal: handles manageOrder and completeOrder tool calls ────────

  async _handleToolCalls(functionCalls) {
    const responses = [];

    for (const fc of functionCalls) {
      let result;

      if (fc.name === 'manageOrder') {
        result = handleManageOrder(this.callSid, fc.args);
      } else if (fc.name === 'completeOrder') {
        result = await handleCompleteOrder(this.callSid, fc.args);

        // Red Team #10 — 22s for full farewell (shortened in systemPrompt)
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

    if (this.session && responses.length > 0) {
      try {
        this.session.sendToolResponse({ functionResponses: responses });
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
