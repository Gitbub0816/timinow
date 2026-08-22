import {
  decodeBase64,
  geminiConfigured,
  geminiModel,
  geminiVoice,
  pcmToWav,
  sampleRateFromMime,
  synthesizeSpeech
} from "../src/gemini-tts.js";
import { acceptedTwiml, buildCallScript, outboundTwiml } from "../src/voice.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ---------------------------------------------------------- WAV bytes --- */

{
  const wav = pcmToWav(new Uint8Array(64).fill(3), { sampleRate: 24000 });
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at, length) => new TextDecoder().decode(wav.subarray(at, at + length));
  assert(tag(0, 4) === "RIFF" && tag(8, 4) === "WAVE" && tag(12, 4) === "fmt " && tag(36, 4) === "data",
    "the WAV chunks are where a player looks for them");
  assert(view.getUint32(4, true) === 36 + 64, "RIFF size counts everything after itself");
  assert(view.getUint32(40, true) === 64, "the data chunk reports the sample count");
  assert(view.getUint16(20, true) === 1 && view.getUint16(34, true) === 16, "16-bit uncompressed PCM");
  assert(view.getUint32(28, true) === 24000 * 2, "byte rate is rate times block align — a wrong one plays at the wrong speed");
  assert(wav.length === 44 + 64, "header is 44 bytes and the samples are untouched");
}

// The rate comes from Gemini's own mime type. A header disagreeing with the
// samples does not fail — it plays chipmunked, which is worse.
assert(sampleRateFromMime("audio/L16;codec=pcm;rate=16000") === 16000, "the declared rate is used");
assert(sampleRateFromMime("audio/L16") === 24000, "a missing rate falls back");
assert(sampleRateFromMime("audio/L16;rate=1") === 24000, "an implausible rate falls back rather than being trusted");
assert(decodeBase64("SGk=")[0] === 72, "base64 audio decodes to bytes");

/* ------------------------------------------------------ configuration --- */

assert(geminiConfigured({ GEMINI_API_KEY: "k" }) === true, "a key turns it on");
assert(geminiConfigured({}) === false, "no key means Twilio speaks");
assert(geminiConfigured({ GEMINI_API_KEY: "   " }) === false, "whitespace is not a key");
assert(geminiVoice({}) === "Charon" && geminiVoice({ GEMINI_TTS_VOICE: "Kore" }) === "Kore", "voice is configurable");
assert(geminiModel({}).includes("tts"), "the default model is a TTS model");

/* ------------------------------------------------- synthesis failures --- */

const realFetch = globalThis.fetch;
async function withFetch(handler, run) {
  globalThis.fetch = handler;
  try { return await run(); } finally { globalThis.fetch = realFetch; }
}

await withFetch(async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 }), async () => {
  let message = "";
  try { await synthesizeSpeech({ GEMINI_API_KEY: "bad" }, { text: "hello" }); } catch (error) { message = error.message; }
  assert(message.includes("API key not valid"), `Google's own reason survives, got: ${message}`);
});

await withFetch(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "no audio here" }] } }] }), { status: 200 }), async () => {
  let message = "";
  try { await synthesizeSpeech({ GEMINI_API_KEY: "k" }, { text: "hello" }); } catch (error) { message = error.message; }
  assert(message.includes("no audio"), "a text-only answer is a failure, not silence");
});

await withFetch(async (url, init) => {
  const body = JSON.parse(init.body);
  assert(body.generationConfig.responseModalities.includes("AUDIO"), "audio is requested");
  assert(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === "Kore", "the configured voice is sent");
  assert(body.contents[0].parts[0].text.includes("calmly"), "the style direction is prepended to the line");
  assert(init.headers["x-goog-api-key"] === "k", "the key travels in the header, not the URL");
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAAAAA==" } }] } }]
  }), { status: 200 });
}, async () => {
  const { wav, voice } = await synthesizeSpeech({ GEMINI_API_KEY: "k", GEMINI_TTS_VOICE: "Kore" }, { text: "hello", style: "Read this calmly." });
  assert(new TextDecoder().decode(wav.subarray(0, 4)) === "RIFF" && voice === "Kore", "a good answer becomes playable WAV");
});

/* ---------------------------------------------------------- fallback --- */

{
  const script = buildCallScript({ locationName: "Hearth", spokenConcern: "a dog", travelMinutes: 9, urgency: "urgent" });
  const withAudio = outboundTwiml({ script, gatherActionUrl: "https://x/g", repeatActionUrl: "https://x/r", audio: { intro: "https://x/a", prompt: "https://x/p" } });
  assert(withAudio.includes("<Play>https://x/a</Play>") && !withAudio.includes("<Say"), "audio replaces speech entirely");

  const withoutAudio = outboundTwiml({ script, gatherActionUrl: "https://x/g", repeatActionUrl: "https://x/r", voice: "Polly.Joanna-Neural" });
  assert(withoutAudio.includes("<Say voice=\"Polly.Joanna-Neural\">") && !withoutAudio.includes("<Play>"),
    "no audio means Twilio speaks — the call is never silent");

  // Partial audio must still produce a complete call.
  const partial = outboundTwiml({ script, gatherActionUrl: "https://x/g", repeatActionUrl: "https://x/r", voice: "Polly.Joanna-Neural", audio: { intro: "https://x/a" } });
  assert(partial.includes("<Play>https://x/a</Play>") && partial.includes("<Say"), "a missing line falls back on its own");

  assert(acceptedTwiml(script, { audioUrl: "https://x/ok" }).includes("<Play>https://x/ok</Play>"), "the keypad replies play too");
  assert(acceptedTwiml(script, { voice: "Polly.Joanna-Neural" }).includes("<Say"), "and fall back too");
}

console.log("Gemini TTS tests passed: WAV container, declared sample rate, base64 audio, configuration, Google's error text surviving, a text-only answer counting as failure, request shape, and <Play>/<Say> fallback including a partial one.");
