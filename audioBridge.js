audioBridge.js
// Converts audio between Twilio's format and Gemini's format
//
// Twilio → Gemini:  mulaw 8000Hz base64  →  PCM16 16000Hz base64
// Gemini → Twilio:  PCM16 24000Hz base64 →  mulaw 8000Hz base64

'use strict';

// ---------------------------------------------------------------------------
// mulaw decode table — maps each mulaw byte (0-255) to a signed PCM16 value
// Built once at startup using the ITU-T G.711 algorithm
// ---------------------------------------------------------------------------
const MULAW_DECODE_TABLE = new Int16Array(256);
(function buildDecodeTable() {
  for (let i = 0; i < 256; i++) {
    const byte   = ~i & 0xFF;
    const sign     = byte & 0x80;
    const exponent = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0F;
    // Bias is 33 (0x21); shift reconstructs the original magnitude
    let sample = ((mantissa << 1) + 33) << (exponent + 2);
    sample -= 33;
    MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
  }
})();

// ---------------------------------------------------------------------------
// Decode mulaw bytes → PCM16 Int16Array
// ---------------------------------------------------------------------------
function mulawToPcm16(mulawBytes) {
  const pcm = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[mulawBytes[i]];
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// Upsample PCM16: 8000 Hz → 16000 Hz  (2× linear interpolation)
//
// Each input sample i produces two output samples:
//   out[2i]   = in[i]
//   out[2i+1] = average of in[i] and in[i+1]
// The final sample is held (no fictitious data invented beyond the buffer).
// ---------------------------------------------------------------------------
function upsample8kTo16k(pcm8k) {
  const len    = pcm8k.length;
  const pcm16k = new Int16Array(len * 2);
  for (let i = 0; i < len; i++) {
    pcm16k[i * 2] = pcm8k[i];
    // For the very last sample there is no "next"; hold the value.
    const next = (i + 1 < len) ? pcm8k[i + 1] : pcm8k[i];
    pcm16k[i * 2 + 1] = (pcm8k[i] + next) >> 1; // integer average, no rounding bias
  }
  return pcm16k;
}

// ---------------------------------------------------------------------------
// Downsample PCM16: 24000 Hz → 8000 Hz  (3:1 with averaging anti-alias filter)
//
// Naive decimation (keep every 3rd sample) causes aliasing because it ignores
// the two discarded samples entirely.  Averaging each 3-sample window is a
// simple but effective low-pass filter that removes energy above 4 kHz before
// decimation, which is exactly the Nyquist limit for an 8 kHz output signal.
// ---------------------------------------------------------------------------
function downsample24kTo8k(pcm24k) {
  const outputLength = Math.floor(pcm24k.length / 3);
  const pcm8k        = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const base = i * 3;
    // Average three consecutive samples (kept as integer arithmetic to stay fast)
    pcm8k[i] = Math.round((pcm24k[base] + pcm24k[base + 1] + pcm24k[base + 2]) / 3);
  }
  return pcm8k;
}

// ---------------------------------------------------------------------------
// Encode PCM16 Int16Array → mulaw Uint8Array  (ITU-T G.711 µ-law)
// ---------------------------------------------------------------------------
function pcm16ToMulaw(pcm16) {
  const mulaw = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    let sample = pcm16[i];

    // Capture sign, then work with the magnitude
    const sign = (sample < 0) ? 0x80 : 0x00;
    if (sample < 0) {
      // Guard against Int16 minimum (-32768): negating it overflows to -32768 again
      sample = (sample === -32768) ? 32767 : -sample;
    }

    // Add bias and clamp to 15-bit range
    sample = Math.min(sample + 33, 32767);

    // Find the most-significant set bit (exponent)
    let exponent = 7;
    let expMask  = 0x4000;
    while (exponent > 0 && (sample & expMask) === 0) {
      exponent--;
      expMask >>= 1;
    }

    // Extract 4-bit mantissa from just below the leading bit
    const mantissa = (sample >> (exponent + 3)) & 0x0F;

    // Combine, invert all 8 bits (G.711 convention), mask to byte
    mulaw[i] = (~(sign | (exponent << 4) | mantissa)) & 0xFF;
  }
  return mulaw;
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Decodes a base64 string to a Buffer and throws a descriptive error if the
 * input is not a non-empty string or if the decoded byte count is not a
 * multiple of `alignment` (use 2 for PCM16 to catch truncated payloads).
 */
function decodeBase64(base64String, label, alignment = 1) {
  if (typeof base64String !== 'string' || base64String.length === 0) {
    throw new TypeError(`${label}: expected a non-empty base64 string`);
  }
  const buf = Buffer.from(base64String, 'base64');
  if (buf.length === 0) {
    throw new RangeError(`${label}: decoded buffer is empty — check your base64 input`);
  }
  if (alignment > 1 && buf.length % alignment !== 0) {
    throw new RangeError(
      `${label}: decoded byte length (${buf.length}) is not a multiple of ${alignment}. ` +
      `PCM16 data must come in pairs of bytes.`
    );
  }
  return buf;
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Convert a Twilio audio chunk to the format Gemini expects.
 *
 * @param  {string} base64MulawChunk  Base64-encoded µ-law audio at 8000 Hz
 * @returns {string}                  Base64-encoded PCM16 audio at 16000 Hz
 */
function twilioAudioToGemini(base64MulawChunk) {
  const mulawBytes = decodeBase64(base64MulawChunk, 'twilioAudioToGemini');
  const pcm8k      = mulawToPcm16(mulawBytes);
  const pcm16k     = upsample8kTo16k(pcm8k);
  return Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength).toString('base64');
}

/**
 * Convert a Gemini audio chunk to the format Twilio expects.
 *
 * @param  {string} base64Pcm24kChunk  Base64-encoded PCM16 audio at 24000 Hz
 * @returns {string}                   Base64-encoded µ-law audio at 8000 Hz
 */
function geminiAudioToTwilio(base64Pcm24kChunk) {
  const pcmBytes = decodeBase64(base64Pcm24kChunk, 'geminiAudioToTwilio', 2);
  const pcm24k   = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
  const pcm8k    = downsample24kTo8k(pcm24k);
  const mulawBytes = pcm16ToMulaw(pcm8k);
  return Buffer.from(mulawBytes).toString('base64');
}

module.exports = {
  twilioAudioToGemini,
  geminiAudioToTwilio,
  // Exported for unit testing
  _internals: {
    mulawToPcm16,
    upsample8kTo16k,
    downsample24kTo8k,
    pcm16ToMulaw,
    MULAW_DECODE_TABLE,
  },
};