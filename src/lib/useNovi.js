import { mergeTranscript } from './transcript.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getItem, setItem } from './storage.js';
import { pairCodeFromHash, deviceName, tryAutoPair } from './pairing.js';
import { stopSpeaking } from './voice.js';

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const initialState = { transcript: [], task: { active: false }, approvals: [], providers: [], projects: [], devices: [], feed: [], thinking: false, accounts: [], googleConfigured: false };

export function useNovi({ onSpeak }) {
  const [token, setToken] = useState(() => getItem('novi.token'));
  const [needsPairing, setNeedsPairing] = useState(() => !isLocal && !getItem('novi.token'));
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState(initialState);
  const wsRef = useRef(null);
  const speakRef = useRef(onSpeak);
  speakRef.current = onSpeak;

  useEffect(() => {
    if (needsPairing) return undefined;
    let closed = false;
    let retry;

    const handle = (msg) => {
      switch (msg.type) {
        case 'snapshot': {
          const { type, ...rest } = msg;
          setState((s) => ({ ...s, ...rest, transcript: mergeTranscript(s.transcript, rest.transcript) }));
          break;
        }
        case 'chat': setState((s) => ({ ...s, transcript: [...s.transcript, msg.entry].slice(-100) })); break;
        case 'feed': setState((s) => ({ ...s, feed: [...s.feed, { text: msg.text, taskId: msg.taskId, at: Date.now() }].slice(-200) })); break;
        case 'task': setState((s) => ({ ...s, task: msg.task })); break;
        case 'approval_added': setState((s) => ({ ...s, approvals: [...s.approvals.filter((a) => a.id !== msg.approval.id), msg.approval] })); break;
        case 'approval_needs_proof': setState((s) => ({ ...s, approvals: s.approvals.map((a) => (a.id === msg.id ? { ...a, need: msg.need } : a)) })); break;
        case 'approval_resolved': setState((s) => ({ ...s, approvals: s.approvals.filter((a) => a.id !== msg.id) })); break;
        case 'thinking': setState((s) => ({ ...s, thinking: msg.on, wakeHeardAt: msg.on ? 0 : s.wakeHeardAt })); break;
        case 'speak': speakRef.current?.(msg.text); break;
        // Updates spoken while Novi wasn't open on this phone, in order.
        case 'missed': for (const line of msg.lines || []) speakRef.current?.(line); break;
        // The laptop microphone heard "Hey Novi" (server wake word): show it's listening.
        case 'wake': setState((s) => ({ ...s, wakeHeardAt: Date.now() })); break;
        case 'wake_timeout': setState((s) => ({ ...s, wakeHeardAt: 0 })); break;
        // "Hey Novi" interrupted Novi on the laptop: stop talking here too.
        case 'stop_speaking': stopSpeaking(); break;
        default: break;
      }
    };

    const connect = () => {
      const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        if (token) ws.send(JSON.stringify({ type: 'hello', token }));
      };
      ws.onmessage = (e) => handle(JSON.parse(e.data));
      ws.onclose = (e) => {
        setConnected(false);
        if (e.code === 4001) {
          setItem('novi.token', null);
          setToken(null);
          setNeedsPairing(true);
          return;
        }
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [needsPairing, token]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }, []);

  const api = useCallback((path, init = {}) => fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }), [token]);

  // A token from any pairing route (QR code, Tailscale, "Ask the laptop").
  const adopt = useCallback((newToken) => {
    setItem('novi.token', newToken);
    setToken(newToken);
    setNeedsPairing(false);
  }, []);

  const pair = useCallback(async (code, name) => {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return body.error || 'Pairing failed.';
    adopt(body.token);
    return null;
  }, [adopt]);

  // Not paired yet: first the QR link's one-time code, then "my own Tailscale phone". Only if both
  // fail does the pair screen show ("Ask the laptop").
  const [autoPairing, setAutoPairing] = useState(needsPairing);
  useEffect(() => {
    if (!needsPairing) return;
    (async () => {
      const code = pairCodeFromHash(window.location.hash);
      if (code) {
        history.replaceState(null, '', window.location.pathname);
        if (!(await pair(code, deviceName(navigator.userAgent)))) return;
      }
      const auto = await tryAutoPair();
      if (auto) adopt(auto);
      else setAutoPairing(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { state, connected, needsPairing, autoPairing, send, pair, adopt, api, isLocal };
}
