/**
 * Speech from Gemini's TTS models, as WAV bytes Twilio can play.
 *
 * Twilio's <Say> can only use voices Twilio hosts, so a voice chosen in AI
 * Studio is unreachable that way. The call has to <Play> audio instead, which
 * means synthesising it ourselves and serving it from a URL Twilio fetches.
 *
 * Gemini returns raw little-endian 16-bit PCM, and Twilio will not play raw
 * PCM — it wants a container. A WAV header is 44 bytes in front of the same
 * samples, so that is the whole conversion: no transcoding, no dependency.
 */

const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_VOICE = "Charon";
const DEFAULT_STYLE = "Read this warmly and calmly, at an unhurried pace, as a real person calling a veterinary clinic. Do not sound cheerful or promotional.";
const SYNTHESIS_HOST = "https://generativelanguage.googleapis.com";

export function geminiVoice(env) {
  return String(env?.GEMINI_TTS_VOICE || "").trim() || DEFAULT_VOICE;
}

/**
 * How the line should be read.
 *
 * This is the whole of what AI Studio calls customising a voice: the model
 * takes direction in the prompt itself, so whatever was typed into the style
 * box there can be pasted here verbatim and every line of every call gets it.
 * There is no separate voice asset to reference — Iapetus read one way and
 * Iapetus read another are the same voice and a different instruction.
 */
export function geminiStyle(env) {
  return String(env?.GEMINI_TTS_STYLE || "").trim() || DEFAULT_STYLE;
}

export function geminiModel(env) {
  return String(env?.GEMINI_TTS_MODEL || "").trim() || DEFAULT_MODEL;
}

/** Whether a Gemini voice is configured at all. Everything falls back to
 *  <Say> when it is not, so this is the only switch. */
export function geminiConfigured(env) {
  return Boolean(String(env?.GEMINI_API_KEY || "").trim());
}

/**
 * Wrap PCM samples in a WAV container.
 *
 * `rate` comes from the response's own mime type rather than a constant:
 * Gemini reports it as `audio/L16;codec=pcm;rate=24000`, and a header that
 * disagrees with the samples plays at the wrong speed rather than failing.
 */
export function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);          // PCM header length
  view.setUint16(20, 1, true);           // 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/** `audio/L16;codec=pcm;rate=24000` -> 24000. Defaults rather than throws:
 *  a missing rate is far likelier than a wrong one. */
export function sampleRateFromMime(mimeType, fallback = 24000) {
  const match = /rate=(\d+)/.exec(String(mimeType || ""));
  const rate = match ? Number(match[1]) : NaN;
  return Number.isFinite(rate) && rate >= 8000 && rate <= 48000 ? rate : fallback;
}

export function decodeBase64(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * One line of speech, as WAV.
 *
 * `style` is prepended as an instruction rather than spoken — Gemini's TTS
 * models take direction in the prompt itself, which is how a clinic call gets
 * a calm reading instead of a breezy one.
 */
export async function synthesizeSpeech(env, { text, voice, style, signal } = {}) {
  const apiKey = String(env?.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const spoken = String(text || "").trim();
  if (!spoken) throw new Error("nothing to say");

  const model = geminiModel(env);
  const chosenVoice = voice || geminiVoice(env);
  const prompt = style ? `${style}\n\n${spoken}` : spoken;

  const response = await fetch(`${SYNTHESIS_HOST}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: chosenVoice } } }
      }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini refused to synthesize: ${detail}`);
  }

  const part = body?.candidates?.[0]?.content?.parts?.find((candidate) => candidate?.inlineData?.data);
  if (!part) throw new Error("Gemini returned no audio — check the model supports TTS and the voice name is valid");
  const pcm = decodeBase64(part.inlineData.data);
  return {
    wav: pcmToWav(pcm, { sampleRate: sampleRateFromMime(part.inlineData.mimeType) }),
    voice: chosenVoice,
    model
  };
}
