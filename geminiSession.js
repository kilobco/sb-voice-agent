// geminiSession.js
// THE FILE PETER 1 IMPORTS. DO NOT RENAME. DO NOT CHANGE EXPORTS.
//
// Implements the contractual interface agreed with Peter 1:
//   new GeminiSession(opts)          — constructor
//   session.start()                  — called when call connects
//   session.onAudio(b64)        — called for every audio chunk from caller
//   session.close()                   — called when call ends or is transferred
//   opts.onAudioResponse(b64)        — you call this with Gemini audio output
//   opts.onTransferRequested(num)    — you call this to trigger cold transfer
//   opts.onSessionEnded()            — you call this after clean session close

require('dotenv').config();

const { GoogleGenAI, Modality } = require('@google/genai');
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
    this.onAudioResponse = onAudioResponse;       // Peter 1 plays this to caller
    this.onTransferRequested = onTransferRequested; // Peter 1 executes cold transfer
    this.onSessionEnded = onSessionEnded;           // Peter 1 cleans up sessions Map

    // ── Internal state ────────────────────────────────────────────────────
    this.session = null;         // Gemini Live session object
    this.sessionPromise = null;  // Promise resolving to session
    this.isActive = false;
    this.outputTranscript = '';  // Accumulate model speech for transfer detection
  }

  // ── Called by Peter 1 when the call connects ──────────────────────────

  async start() {
    try {
      // Create the in-memory cart for this call
      createSession(this.callSid, this.callDbId);

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      this.sessionPromise = ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
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

            // Trigger the agent to speak first immediately on connect
            this.sessionPromise.then(session => {
              const hour = new Date().getHours();
              const greeting =
                hour < 12 ? 'Good morning'
                  : hour < 17 ? 'Good afternoon'
                    : 'Good evening';

              session.sendRealtimeInput([{
                text: `[START_CALL] ${greeting}. Begin your opening greeting immediately.`
              }]);
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

  onAudio(base64Pcm16kChunk) {
    if (!this.isActive || !this.session) return;
    try {
      this.session.sendRealtimeInput({
        media: {
          mimeType: 'audio/pcm;rate=16000',
          data: base64Pcm16kChunk
        }
      });
    } catch (err) {
      // Session may have closed — ignore silently
    }
  }

  // ── Called by Peter 1 when the call ends ─────────────────────────────

  close() {
    this._cleanup();
  }

  // ── Internal: handles all incoming Gemini server messages ────────────

  async _handleMessage(msg) {
    // Handle audio interruption (customer talks over agent)
    if (msg.serverContent?.interrupted) {
      // Nothing to do server-side — Peter 1 handles audio queue clearing
      return;
    }

    // Handle audio response from Gemini → forward to Peter 1 → caller
    const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData && this.onAudioResponse) {
      this.onAudioResponse(audioData);
    }

    // Handle tool calls fired by Gemini
    if (msg.toolCall) {
      await this._handleToolCalls(msg.toolCall.functionCalls);
    }

    // Accumulate output transcript for transfer phrase detection
    if (msg.serverContent?.outputTranscription?.text) {
      this.outputTranscript += msg.serverContent.outputTranscription.text;
    }

    // On turn complete — scan transcript for transfer trigger
    if (msg.serverContent?.turnComplete) {
      if (this.outputTranscript.includes(TRANSFER_PHRASE)) {
        console.log(`Transfer phrase detected on call: ${this.callSid}`);
        if (this.onTransferRequested) {
          this.onTransferRequested(TRANSFER_NUMBER);
        }
      }
      this.outputTranscript = ''; // Reset for next turn
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

        // Schedule session end 12 seconds after confirmed order
        // (gives agent time to say farewell)
        if (result.orderId) {
          setTimeout(() => this._cleanup(), 12000);
        }
      }

      responses.push({
        id: fc.id,
        name: fc.name,
        response: result
      });
    }

    // Send all tool responses back to Gemini in a single call
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

    if (this.session) {
      try { this.session.close(); } catch (e) { }
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