import { useCallback, useRef, useState } from "react";

const b64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000)
    s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (str) => {
  const s = atob(str),
    u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
};

export function useLiveCall() {
  const [status, setStatus] = useState({ text: "Not connected", kind: "" });
  const [log, setLog] = useState([]);
  const [level, setLevel] = useState(0);
  const [active, setActive] = useState(false);
  const r = useRef({
    ws: null,
    mic: null,
    stream: null,
    play: null,
    next: 0,
    sources: new Set(),
    live: false,
    lastRole: null,
  });

  const addText = (role, text) =>
    setLog((l) => {
      const last = l[l.length - 1];
      if (last && last.role === role && !last.done)
        return [...l.slice(0, -1), { ...last, text: last.text + text }];
      return [...l, { role, text, done: false }];
    });
  const addSys = (text) =>
    setLog((l) => [
      ...l.map((m) => ({ ...m, done: true })),
      { role: "sys", text, done: true },
    ]);
  const endTurn = () => setLog((l) => l.map((m) => ({ ...m, done: true })));

  const stopPlayback = () => {
    const s = r.current;
    s.sources.forEach((x) => {
      try {
        x.stop();
      } catch {}
    });
    s.sources.clear();
    s.next = 0;
  };

  const play = (data) => {
    const s = r.current;
    if (!s.play) return;
    const pcm = new Int16Array(unb64(data));
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    const buf = s.play.createBuffer(1, f.length, 24000);
    buf.copyToChannel(f, 0);
    const src = s.play.createBufferSource();
    src.buffer = buf;
    src.connect(s.play.destination);
    s.next = Math.max(s.next, s.play.currentTime + 0.04);
    src.start(s.next);
    s.next += buf.duration;
    s.sources.add(src);
    src.onended = () => s.sources.delete(src);
  };

  const cleanup = useCallback(() => {
    const s = r.current;
    s.live = false;
    stopPlayback();
    s.stream?.getTracks().forEach((t) => t.stop());
    s.mic?.close();
    s.play?.close();
    s.stream = s.mic = s.play = null;
    setLevel(0);
    setActive(false);
  }, []);

  const startMic = async () => {
    const s = r.current;
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      s.mic = new AudioContext();
      await s.mic.audioWorklet.addModule("/capture-worklet.js");
      const node = new AudioWorkletNode(s.mic, "capture");
      node.port.onmessage = (e) => {
        setLevel(Math.min(100, e.data.peak * 140));
        if (s.live && s.ws?.readyState === 1)
          s.ws.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: b64(e.data.pcm),
                  mimeType: "audio/pcm;rate=16000",
                },
              },
            }),
          );
      };
      s.mic.createMediaStreamSource(s.stream).connect(node);
      s.live = true;
      setStatus({ text: "Connected. Speak any time.", kind: "on" });
      addSys("Call connected");
      if (s.speakFirst)
        s.ws.send(JSON.stringify({ realtimeInput: { text: "Hello" } }));
    } catch (err) {
      addSys("Microphone problem: " + err.message);
      setStatus({ text: "Microphone unavailable", kind: "err" });
      end();
    }
  };

  const onMessage = (ev) => {
    console.log("🚀 ~ onMessage ~ ev:", ev);
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.setupComplete) return startMic();
    if (m.error) {
      console.log("🚀 ~ onMessage ~ m.error:", m.error);
      addSys(m.error.message || "Error");
      setStatus({ text: "Error", kind: "err" });
      return;
    }
    if (m.toolCall) {
      const calls = m.toolCall.functionCalls || [];
      r.current.ws.send(
        JSON.stringify({
          toolResponse: {
            functionResponses: calls.map((c) => ({
              id: c.id,
              name: c.name,
              response: { result: "ok" },
            })),
          },
        }),
      );
      const hangup = calls.find((c) => c.name === "end_call");
      if (hangup) scheduleHangup(hangup.args?.reason);
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) stopPlayback();
    sc.modelTurn?.parts?.forEach(
      (p) => p.inlineData?.data && play(p.inlineData.data),
    );
    if (sc.inputTranscription?.text) addText("me", sc.inputTranscription.text);
    if (sc.outputTranscription?.text)
      addText("ai", sc.outputTranscription.text);
    if (sc.turnComplete) endTurn();
  };

  const scheduleHangup = (reason) => {
    console.log("🚀 ~ scheduleHangup ~ reason:", reason)
    const s = r.current;
    if (s.hanging) return;
    s.hanging = true;
    addSys("Agent is ending the call" + (reason ? ": " + reason : ""));
    const t0 = Date.now();
    const timer = setInterval(() => {
      const waited = Date.now() - t0;
      // Hang up once the goodbye audio has finished playing (with a hard cap).
      if ((s.sources.size === 0 && waited > 1500) || waited > 12000) {
        clearInterval(timer);
        end();
      }
    }, 250);
  };

  const start = (cfg) => {
    console.log("🚀 ~ start ~ cfg:", cfg);
    const s = r.current;
    s.speakFirst = cfg.speakFirst;
    s.hanging = false;
    s.play = new AudioContext({ sampleRate: 24000 });
    s.play.resume();
    setActive(true);
    setStatus({ text: "Connecting...", kind: "" });
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`,
    );
    s.ws = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          model: cfg.model,
          voice: cfg.voice,
          prompt: cfg.prompt,
        }),
      );
    ws.onmessage = onMessage;
    ws.onerror = () =>
      setStatus({ text: "Cannot reach server (is it running?)", kind: "err" });
    ws.onclose = () => {
      if (r.current.live) addSys("Call ended");
      setStatus((st) =>
        st.kind === "err" ? st : { text: "Not connected", kind: "" },
      );
      cleanup();
    };
  };

  const end = () => {
    const ws = r.current.ws;
    if (ws && ws.readyState < 2) ws.close(1000);
    else cleanup();
  };

  return { status, log, level, active, start, end };
}
