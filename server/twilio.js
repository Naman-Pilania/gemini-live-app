import "dotenv/config";
import { WebSocket, WebSocketServer } from "ws";
import twilio from "twilio";

const {
  GEMINI_API_KEY,
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_NUMBER,
  PUBLIC_URL,
} = process.env;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-live-preview";
const VOICE = process.env.GEMINI_VOICE || "Puck";
const PROMPT =
  process.env.CALL_PROMPT ||
  "You are Maya, a friendly appointment-booking assistant for Brightside Dental Clinic. Keep replies short and conversational. Ask one question at a time. Collect the caller's name, preferred date and time, and reason for the visit, then confirm back.";
const END_RULES = `\n\nCall ending rules: When the request is fully handled or the caller says goodbye, say a brief goodbye out loud, then call end_call. Never call it mid-task. After calling it, say nothing more.`;
const GEMINI_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
  GEMINI_API_KEY;

// ---- G.711 mu-law <-> PCM16 ----
const ulaw2lin = (u) => {
  u = ~u & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? 0x84 - t : t - 0x84;
};
const lin2ulaw = (s) => {
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > 32635) s = 32635;
  s += 0x84;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
};

export function addCallRoute(app) {
  app.post("/call", async (req, res) => {
    try {
      const to = req.body?.to;
      if (!to || !PUBLIC_URL)
        return res
          .status(400)
          .json({ error: 'Send {"to": "+..."} and set PUBLIC_URL in .env' });
      const wsUrl =
        PUBLIC_URL.replace(/^http/, "ws").replace(/\/$/, "") + "/twilio";
      const call = await twilio(SID, TOKEN).calls.create({
        to,
        from: TWILIO_NUMBER,
        twiml: `<Response><Connect><Stream url="${wsUrl}"/></Connect></Response>`,
      });
      res.json({ sid: call.sid, status: call.status });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

export const twilioWss = new WebSocketServer({ noServer: true });

twilioWss.on("connection", (tw) => {
  let streamSid,
    callSid,
    ready = false,
    greeted = false,
    endRequested = false;
  let prev = 0,
    leftover = new Int16Array(0),
    markTimer,
    hardTimer;

  const sendTw = (o) =>
    tw.readyState === WebSocket.OPEN && tw.send(JSON.stringify(o));
  const hangup = () => {
    if (callSid)
      twilio(SID, TOKEN)
        .calls(callSid)
        .update({ status: "completed" })
        .catch(() => {});
  };
  const gem = new WebSocket(GEMINI_URL);
  const sendGem = (o) =>
    gem.readyState === WebSocket.OPEN && gem.send(JSON.stringify(o));
  const maybeGreet = () => {
    if (ready && streamSid && !greeted) {
      greeted = true;
      sendGem({ realtimeInput: { text: "Hello" } });
    }
  };

  gem.on("open", () =>
    sendGem({
      setup: {
        model: "models/" + MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
          },
        },
        systemInstruction: { parts: [{ text: PROMPT + END_RULES }] },
        tools: [
          {
            functionDeclarations: [
              {
                name: "end_call",
                description: "Ends the call. Only after saying goodbye.",
                parameters: {
                  type: "OBJECT",
                  properties: { reason: { type: "STRING" } },
                  required: ["reason"],
                },
              },
            ],
          },
        ],
      },
    }),
  );

  gem.on("message", (d) => {
    let m;
    try {
      m = JSON.parse(d.toString());
    } catch {
      return;
    }
    if (m.setupComplete) {
      ready = true;
      return maybeGreet();
    }
    if (m.toolCall) {
      const calls = m.toolCall.functionCalls || [];
      sendGem({
        toolResponse: {
          functionResponses: calls.map((c) => ({
            id: c.id,
            name: c.name,
            response: { result: "ok" },
          })),
        },
      });
      if (calls.some((c) => c.name === "end_call")) {
        endRequested = true;
        hardTimer = setTimeout(hangup, 15000); // safety net
        armMark();
      }
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) sendTw({ event: "clear", streamSid });
    for (const p of sc.modelTurn?.parts || []) {
      if (!p.inlineData?.data) continue;
      const b = Buffer.from(p.inlineData.data, "base64");
      const pcm = new Int16Array(
        b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
      );
      const all = new Int16Array(leftover.length + pcm.length);
      all.set(leftover);
      all.set(pcm, leftover.length);
      const n = Math.floor(all.length / 3),
        out = Buffer.alloc(n);
      for (let i = 0; i < n; i++)
        out[i] = lin2ulaw(
          ((all[3 * i] + all[3 * i + 1] + all[3 * i + 2]) / 3) | 0,
        );
      leftover = all.slice(n * 3);
      sendTw({
        event: "media",
        streamSid,
        media: { payload: out.toString("base64") },
      });
      if (endRequested) armMark();
    }
  });

  // After the goodbye audio stops arriving, ask Twilio to confirm playback finished, then hang up.
  function armMark() {
    clearTimeout(markTimer);
    markTimer = setTimeout(
      () => sendTw({ event: "mark", streamSid, mark: { name: "hangup" } }),
      1000,
    );
  }

  tw.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.event === "start") {
      streamSid = m.start.streamSid;
      callSid = m.start.callSid;
      maybeGreet();
    } else if (m.event === "media") {
      const mu = Buffer.from(m.media.payload, "base64"),
        out = new Int16Array(mu.length * 2);
      for (let i = 0; i < mu.length; i++) {
        const cur = ulaw2lin(mu[i]);
        out[2 * i] = (prev + cur) >> 1;
        out[2 * i + 1] = cur;
        prev = cur;
      }
      sendGem({
        realtimeInput: {
          audio: {
            data: Buffer.from(out.buffer).toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      });
    } else if (m.event === "mark" && m.mark?.name === "hangup") hangup();
    else if (m.event === "stop") gem.close();
  });

  const cleanup = () => {
    clearTimeout(markTimer);
    clearTimeout(hardTimer);
    if (gem.readyState < 2) gem.close();
  };
  tw.on("close", cleanup);
  gem.on("close", () => tw.readyState < 2 && tw.close());
  gem.on("error", (e) => console.error("Gemini error:", e.message));
});
