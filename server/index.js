import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { addCallRoute, twilioWss } from "./twilio.js";

const PORT = process.env.PORT || 3001;
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) console.warn("Missing GEMINI_API_KEY in server/.env");

const GEMINI_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
  KEY;

const END_RULES = `

Call ending rules: When the caller's request is fully handled, or they say goodbye, thanks, "that's all", or otherwise signal they are done, say a brief goodbye out loud first, then call the end_call function. Also call end_call if the caller asks to hang up. Never call end_call in the middle of a task or while a question is unanswered. After calling end_call, say nothing more.`;

console.log("🚀 ~ GEMINI_URL:", GEMINI_URL);

const app = express();
app.use(express.json());
addCallRoute(app);
app.get("/health", (_req, res) => res.json({ ok: true, keyConfigured: !!KEY }));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://x");
  const target =
    pathname === "/live" ? wss : pathname === "/twilio" ? twilioWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) =>
    target.emit("connection", ws, req),
  );
});

// Browser <-> this server <-> Gemini Live. The API key never reaches the browser.
wss.on("connection", (client) => {
  let upstream = null;
  const queue = [];

  const toClient = (obj) =>
    client.readyState === WebSocket.OPEN && client.send(JSON.stringify(obj));

  client.on("message", (data) => {
    const text = data.toString();

    // First message from the browser is the call config.
    if (!upstream) {
      let cfg;
      try {
        cfg = JSON.parse(text);
      } catch {
        return toClient({ error: { message: "Bad config" } });
      }

      upstream = new WebSocket(GEMINI_URL);
      upstream.on("open", () => {
        upstream.send(
          JSON.stringify({
            setup: {
              model:
                "models/" +
                String(cfg.model || "gemini-3.1-flash-live-preview").replace(
                  /^models\//,
                  "",
                ),
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: cfg.voice || "Puck" },
                  },
                },
              },
              systemInstruction: {
                parts: [
                  {
                    text:
                      (cfg.prompt || "You are a helpful voice assistant.") +
                      END_RULES,
                  },
                ],
              },
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: "end_call",
                      description:
                        "Ends the call. Call this only after saying goodbye.",
                      parameters: {
                        type: "OBJECT",
                        properties: {
                          reason: {
                            type: "STRING",
                            description:
                              "Short reason, e.g. 'booking confirmed'",
                          },
                        },
                        required: ["reason"],
                      },
                    },
                  ],
                },
              ],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          }),
        );
        queue.splice(0).forEach((m) => upstream.send(m));
      });
      upstream.on(
        "message",
        (d) =>
          client.readyState === WebSocket.OPEN && client.send(d.toString()),
      );
      upstream.on("error", (e) =>
        toClient({ error: { message: "Upstream error: " + e.message } }),
      );
      upstream.on("close", (code, reason) => {
        toClient({
          error: {
            message: `Gemini closed the session (${code}) ${reason}`.trim(),
          },
        });
        client.close(1000);
      });
      return;
    }

    // Everything after that (audio / text) is forwarded as-is.
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else queue.push(text);
  });

  client.on("close", () => upstream && upstream.close());
});

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
