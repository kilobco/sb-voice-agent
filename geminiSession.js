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
const { GoogleGenAI, Type } = require('@google/genai');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { tools } = require('./toolDefinitions');
const {
  createSession,
  searchMenu,
  handleManageOrder,
  collectCustomerDetails,
  handleCompleteOrder,
  deleteSession
} = require('./orderManager');

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TRANSFER_PHRASE = 'TRANSFER_TO_HUMAN';
const TRANSFER_NUMBER = process.env.RESTAURANT_TRANSFER_NUMBER;

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      _nonSerializable: true,
      type: typeof value,
      error: err?.message || String(err),
    });
  }
}

function redactToolArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  if (typeof out.phoneNumber === 'string') {
    const digits = out.phoneNumber.replace(/\D/g, '');
    out.phoneNumber = digits.length > 4 ? `***${digits.slice(-4)}` : '***';
  }
  if (typeof out.customerName === 'string') {
    out.customerName = out.customerName.length ? `${out.customerName[0]}***` : '***';
  }
  return out;
}

function buildToolSchemaIndex() {
  const decls = tools?.[0]?.functionDeclarations;
  if (!Array.isArray(decls)) return new Map();
  const m = new Map();
  for (const d of decls) {
    if (d?.name) m.set(d.name, d);
  }
  return m;
}

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

    // Red Team #9 — Persistent transcript across all turns, never reset mid-session.
    this.outputTranscript = '';
    this.transferTriggered = false;

    // Order lock — prevents close() from killing session mid-completeOrder.
    this.orderInProgress = false;

    // Fix: pause audio forwarding while a tool call is in flight to prevent
    // simultaneous audio + tool response writes that can cause 1011.
    this.toolCallInProgress = false;

    // Fix: VAD can cancel a pending tool call mid-flight. When Gemini sends
    // the interrupted message, we must NOT send sendToolResponse for that
    // cancelled call — doing so causes the server-side 1011.
    this.wasInterrupted = false;

    // Barge-in: track whether the agent is currently speaking.
    // When Gemini sends interrupted, we gate onAudioResponse immediately so
    // buffered audio chunks stop reaching the caller's ear.
    this.agentSpeaking = false;

    // Fix: early 1011 on session open — sendClientContent fired too quickly.
    // Retry up to 2 times before giving up and cleaning up.
    this.retryCount = 0;
    this._retrying = false;
    this.greetingSent = false;

    // Tool schema cache (used for validation + logging only)
    this._toolDecls = buildToolSchemaIndex();
  }

  // ── Called by Peter 1 when the call connects ──────────────────────────

  async start() {
    try {
      // Create the in-memory cart for this call (only on first start, not retries)
      if (!this._retrying) {
        createSession(this.callSid, this.callDbId);
      }

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
          inputAudioTranscription: {},
          // Barge-in / interruption tuning for phone audio.
          // Phone calls via Twilio have more background noise than browser mics,
          // so the default VAD sensitivity is too conservative — it misses the
          // customer speaking over the agent. These settings make it fire faster:
          //   START_SENSITIVITY_HIGH  — trigger speech detection sooner
          //   END_SENSITIVITY_LOW     — don't cut off mid-sentence after a pause
          //   silenceDurationMs 600   — wait 600ms of silence before end-of-turn
          //                            (handles "uh", "umm", natural pauses)
          //   prefixPaddingMs 200     — include 200ms before speech onset so
          //                            the first word is never clipped
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
              endOfSpeechSensitivity:   'END_SENSITIVITY_LOW',
              prefixPaddingMs:          200,
              silenceDurationMs:        600,
            }
          },
        },
        callbacks: {
          onopen: () => {
            console.log(`Gemini session open for call: ${this.callSid}`);
            this.isActive = true;

            // Fix: wait 500ms after WebSocket open before triggering greeting.
            // Sending too quickly causes a 1011 before Gemini is ready.
            setTimeout(() => {
              if (!this.isActive) return; // session may have closed during the wait

              this.sessionPromise.then(session => {
                if (!this.isActive) return;

                const hour = new Date().getHours();
                const greeting =
                  hour < 12 ? 'Good morning'
                    : hour < 17 ? 'Good afternoon'
                      : 'Good evening';

                this.greetingSent = true;

                const greetingPayload = {
                  turns: [{
                    role: 'user',
                    parts: [{ text: `[START_CALL] ${greeting}. Begin your opening greeting immediately.` }],
                  }],
                  turnComplete: true,
                };

                try {
                  session.sendClientContent(greetingPayload);
                } catch (err) {
                  console.error(
                    `[${this.callSid}] sendClientContent(greeting) threw:`,
                    err?.message || err,
                    '| payload:',
                    safeJson(greetingPayload)
                  );
                }
              });
            }, 500);
          },

          onmessage: async (msg) => {
            // Capture raw Gemini payloads for debugging 1008/1011 causes.
            // This is intentionally verbose; it helps correlate failures with specific server messages.
            if (msg?.error || msg?.serverContent?.error || msg?.setup?.error) {
              console.error(`[${this.callSid}] Gemini message contains error:`, safeJson(msg));
            }
            await this._handleMessage(msg);
          },

          onclose: (e) => {
            const closeInfo = {
              code: e?.code,
              reason: e?.reason,
              wasClean: e?.wasClean,
              type: e?.type,
            };
            console.log(`Gemini session closed for call: ${this.callSid}`, closeInfo, '| raw:', safeJson(e));

            // Fix: if we get a 1011 before the greeting was ever sent, it's
            // likely a server-side init race. Retry up to 2 times.
            if (e?.code === 1011 && !this.greetingSent && this.retryCount < 2) {
              this.retryCount++;
              console.log(`[${this.callSid}] 1011 before greeting — retry attempt ${this.retryCount}`);
              this.session = null;
              this.sessionPromise = null;
              this.isActive = false;
              this._retrying = true;
              setTimeout(() => this.start(), 1000);
            } else {
              this._cleanup();
            }
          },

          onerror: (e) => {
            console.error(
              `Gemini session error for call: ${this.callSid}`,
              '| raw:',
              safeJson(e),
              '| message:',
              e?.message,
              '| code:',
              e?.code
            );
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
    // Fix: do not forward audio while a tool call is in progress.
    // Concurrent writes cause 1011.
    if (!this.isActive || !this.session || this.toolCallInProgress) return;
    try {
      this.session.sendRealtimeInput({
        // FIX: JS SDK uses audio:{data,mimeType} not media:{mimeType,data}
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
    // Barge-in: user spoke over the agent. Gemini cancels its current turn.
    // Set wasInterrupted so tool calls don't fire sendToolResponse.
    // Clear agentSpeaking so audio forwarding stops immediately — any buffered
    // chunks queued after this point are dropped, cutting audio to the caller.
    if (msg.serverContent?.interrupted) {
      this.wasInterrupted = true;
      this.agentSpeaking = false;
      console.log(`[${this.callSid}] Barge-in detected — agent audio cut`);
      return;
    }

    // Forward agent audio to caller only while agentSpeaking is true.
    // agentSpeaking is set true when the first audio part arrives in a turn,
    // and cleared on interrupt (above) or turnComplete (below).
    const parts = msg.serverContent?.modelTurn?.parts;
    if (parts && this.onAudioResponse) {
      for (const part of parts) {
        if (part?.inlineData?.data) {
          this.agentSpeaking = true; // agent has started speaking this turn
          if (this.agentSpeaking) {  // gate: drop chunks if interrupted mid-batch
            this.onAudioResponse(part.inlineData.data);
          }
        }
      }
    }

    // Handle tool calls fired by Gemini
    if (msg.toolCall) {
      await this._handleToolCalls(msg.toolCall.functionCalls);
    }

    // Red Team #9 — accumulate persistently for transfer detection
    if (msg.serverContent?.outputTranscription?.text) {
      this.outputTranscript += msg.serverContent.outputTranscription.text;
    }

    if (msg.serverContent?.turnComplete) {
      this.agentSpeaking = false; // agent finished speaking — reset for next turn
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

  // ── Internal: handles all tool calls from Gemini ──────────────────────

  async _handleToolCalls(functionCalls) {
    // Fix: block audio forwarding while tool calls are in flight
    this.toolCallInProgress = true;

    const responses = [];

    // Snapshot session ref before any awaits — close() may null this.session
    const sessionSnapshot = this.session;

    for (const fc of functionCalls) {
      let result;

      try {
        // Log tool call details + validate args against toolDefinitions.js schema.
        this._logAndValidateToolCall(fc);

        if (fc.name === 'searchMenu') {
          // Synchronous — just searches the in-memory PRICE_MAP
          result = searchMenu(fc.args?.query);

        } else if (fc.name === 'manageOrder') {
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

          // Red Team #10 — 22s for full farewell after confirmed order
          if (result?.orderId) {
            setTimeout(() => this._cleanup(), 22000);
          }

        } else {
          // Unknown tool — return a safe fallback so Gemini isn't left hanging
          console.warn(`[${this.callSid}] Unknown tool called: ${fc.name}`);
          result = { result: `Tool "${fc.name}" is not available.` };
        }
      } catch (err) {
        console.error(`[${this.callSid}] Tool "${fc.name}" threw:`, err.message);
        result = { result: 'Sorry, there was a brief error. Please try again.' };
      }

      // Log tool response shape (helps debug 1008 policy/protocol closures)
      if (result === null || result === undefined) {
        console.warn(`[${this.callSid}] Tool "${fc.name}" returned ${result} (will still sendToolResponse)`);
      } else if (typeof result !== 'object') {
        console.warn(`[${this.callSid}] Tool "${fc.name}" returned non-object (${typeof result}):`, result);
      }

      responses.push({
        id: fc.id,
        name: fc.name,
        response: result
      });
    }

    // Fix: if Gemini sent an interrupted message while we were awaiting,
    // do NOT call sendToolResponse — it will cause a 1011.
    // Use snapshot — this.session may be null if caller hung up during await
    if (sessionSnapshot && responses.length > 0 && !this.wasInterrupted) {
      try {
        // Emit a compact summary of what we're about to send.
        const summary = responses.map(r => ({
          id: r.id,
          name: r.name,
          responseType: typeof r.response,
          responseKeys: (r.response && typeof r.response === 'object') ? Object.keys(r.response).slice(0, 12) : [],
        }));
        console.log(`[${this.callSid}] sendToolResponse(functionResponses) summary:`, safeJson(summary));
        sessionSnapshot.sendToolResponse({ functionResponses: responses });
      } catch (err) {
        console.error(`[${this.callSid}] sendToolResponse error:`, err?.message || err, '| responses:', safeJson(responses));
      }
    } else if (this.wasInterrupted) {
      console.log(`[${this.callSid}] Tool call was interrupted — skipping sendToolResponse`);
    }

    // Reset flags for next turn
    this.wasInterrupted = false;
    this.toolCallInProgress = false;
  }

  // ── Internal: close Gemini session and clean up state ─────────────────

  _cleanup() {
    if (!this.isActive) return;

    this.isActive = false;

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

  _logAndValidateToolCall(fc) {
    const name = fc?.name || 'unknown';
    const id = fc?.id;
    const args = fc?.args;

    console.log(
      `[${this.callSid}] Tool call received:`,
      safeJson({ id, name, args: redactToolArgs(args) })
    );

    const decl = this._toolDecls.get(name);
    if (!decl?.parameters) {
      console.warn(`[${this.callSid}] No tool schema found for "${name}" (cannot validate args)`);
      return;
    }

    if (!args || typeof args !== 'object') {
      console.warn(`[${this.callSid}] Tool "${name}" args is not an object:`, safeJson(args));
      return;
    }

    const schemaProps = decl.parameters?.properties || {};
    const required = Array.isArray(decl.parameters?.required) ? decl.parameters.required : [];

    // Missing required fields
    for (const key of required) {
      if (!(key in args)) {
        console.warn(`[${this.callSid}] Tool "${name}" missing required arg "${key}" | args:`, safeJson(redactToolArgs(args)));
      }
    }

    // Type checks + unexpected fields
    for (const [k, v] of Object.entries(args)) {
      if (!schemaProps[k]) {
        console.warn(`[${this.callSid}] Tool "${name}" received unexpected arg "${k}" | valueType: ${typeof v}`);
        continue;
      }

      const expectedType = schemaProps[k]?.type;
      if (expectedType === Type.STRING && typeof v !== 'string') {
        console.warn(`[${this.callSid}] Tool "${name}" arg "${k}" expected STRING but got ${typeof v} | value:`, safeJson(v));
      }
      if (expectedType === Type.NUMBER && typeof v !== 'number') {
        console.warn(`[${this.callSid}] Tool "${name}" arg "${k}" expected NUMBER but got ${typeof v} | value:`, safeJson(v));
      }
      if (expectedType === Type.INTEGER) {
        if (typeof v !== 'number' || !Number.isInteger(v)) {
          console.warn(`[${this.callSid}] Tool "${name}" arg "${k}" expected INTEGER but got ${typeof v} | value:`, safeJson(v));
        }
      }
      if (expectedType === Type.OBJECT && (typeof v !== 'object' || v === null || Array.isArray(v))) {
        console.warn(`[${this.callSid}] Tool "${name}" arg "${k}" expected OBJECT but got ${typeof v} | value:`, safeJson(v));
      }
    }
  }
}

module.exports = GeminiSession;
