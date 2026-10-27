import { useEffect, useRef, useState } from "react";
import { useLiveCall } from "./useLiveCall.js";

const VOICES = ["Puck", "Kore", "Charon", "Aoede", "Fenrir", "Leda", "Zephyr"];
const DEFAULT_PROMPT =
  "You are Maya, a friendly appointment-booking assistant for Brightside Dental Clinic. Keep replies short and conversational, one or two sentences at a time. Ask one question at a time. Collect the caller's name, preferred date and time, and reason for the visit, then confirm the details back to them.";

export default function App() {
  const { status, log, level, active, start, end } = useLiveCall();
  const [model, setModel] = useState("gemini-3.1-flash-live-preview");
  const [voice, setVoice] = useState("Puck");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [speakFirst, setSpeakFirst] = useState(true);
  const logRef = useRef(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  return (
    <main>
      <header>
        <h1>Gemini Live voice call</h1>
        <p className="sub">
          React front end, Node relay. Your API key stays on the server. Use
          headphones to avoid echo.
        </p>
      </header>

      <section className="card" aria-label="Settings">
        <label htmlFor="model">Model</label>
        <input
          id="model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={active}
          spellCheck="false"
        />
        <label htmlFor="voice">Voice</label>
        <select
          id="voice"
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          disabled={active}
        >
          {VOICES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <label htmlFor="prompt">System prompt</label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={active}
        />
        <div className="row">
          <input
            type="checkbox"
            id="first"
            checked={speakFirst}
            onChange={(e) => setSpeakFirst(e.target.checked)}
            disabled={active}
          />
          <label htmlFor="first">Agent speaks first</label>
        </div>
        <button
          className={active ? "end" : ""}
          onClick={() =>
            active ? end() : start({ model, voice, prompt, speakFirst })
          }
        >
          {active ? "End call" : "Start call"}
        </button>
      </section>

      <section className="card" aria-label="Conversation">
        <div className="status">
          <span className={"dot " + status.kind} />
          <span>{status.text}</span>
        </div>
        <div className="meter" aria-hidden="true">
          <i style={{ width: level + "%" }} />
        </div>
        <div id="log" ref={logRef} aria-live="polite">
          {log.length === 0 && (
            <div className="empty">
              Start the call to talk.
              <br />
              Transcripts appear here.
            </div>
          )}
          {log.map((m, i) => (
            <div key={i} className={"msg " + m.role}>
              {m.text}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
