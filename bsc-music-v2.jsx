import { useState, useEffect, useRef, useCallback } from "react";
import * as Tone from "tone";

/* ═══════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════ */

// Public HTTP endpoints — tried in order until one succeeds
const BSC_HTTP_POOL = [
  "https://bsc-rpc.publicnode.com",          // publicnode (good CORS)
  "https://bsc.drpc.org",                    // drpc (permissive CORS)
  "https://binance.llamarpc.com",            // LlamaRPC
  "https://bsc-dataseed1.binance.org/",      // official #1
  "https://bsc-dataseed2.binance.org/",      // official #2
  "https://bsc-dataseed3.binance.org/",      // official #3
  "https://bsc-dataseed4.binance.org/",      // official #4
];

const BSC_WS_FALLBACK = "wss://bsc-rpc.publicnode.com";

// NodeReal endpoints (requires API key from https://nodereal.io)
const NODEREAL_HTTP = key => `https://bsc-mainnet.nodereal.io/v1/${key}`;
const NODEREAL_WS   = key => `wss://bsc-mainnet.nodereal.io/ws/v1/${key}`;

// Round-robin index across the pool (module-level, shared)
let _poolIdx = 0;
const nextHttp = () => {
  const url = BSC_HTTP_POOL[_poolIdx % BSC_HTTP_POOL.length];
  _poolIdx++;
  return url;
};

const SCALES = {
  pentatonic:  { notes: ["C","D","E","G","A"],               label: "五声"   },
  blues:       { notes: ["C","Eb","F","Gb","G","Bb"],         label: "蓝调"   },
  major:       { notes: ["C","D","E","F","G","A","B"],        label: "大调"   },
  minor:       { notes: ["C","D","Eb","F","G","Ab","Bb"],     label: "小调"   },
  dorian:      { notes: ["C","D","Eb","F","G","A","Bb"],      label: "多利亚" },
  mixolydian:  { notes: ["C","D","E","F","G","A","Bb"],       label: "混合"   },
  japanese:    { notes: ["C","Db","F","G","Ab"],              label: "日本"   },
  wholetone:   { notes: ["C","D","E","Gb","Ab","Bb"],         label: "全音"   },
};

const NHEX = {
  C:"#FF6B6B", D:"#FF9F43", E:"#FECA57", F:"#48DBFB",
  G:"#1DD1A1", A:"#A29BFE", B:"#FD79A8",
  Eb:"#81ECEC", Gb:"#74B9FF", Bb:"#F368E0",
  Db:"#55EFC4", Ab:"#E17055",
};
const ncolor = n => NHEX[n.replace(/[#\d]/g, "")] || "#aaa";

const TRACKS = [
  { id:"transfer", label:"Transfer", color:"#00d4ff", emoji:"💸", desc:"ETH/BNB 转账" },
  { id:"defi",     label:"DeFi/NFT", color:"#ffd700", emoji:"🔮", desc:"合约调用"     },
  { id:"deploy",   label:"Deploy",   color:"#ff6b6b", emoji:"🚀", desc:"合约部署"     },
  { id:"ambient",  label:"Ambient",  color:"#a29bfe", emoji:"🌊", desc:"环境声层"     },
  { id:"txbeat",   label:"TX Beat",  color:"#ff9f43", emoji:"🥁", desc:"交易数量节拍" },
];

const BPH        = 8000;  // BSC ~450ms/block → ~8000 blocks/hour
const BLOCK_MS   = 450;   // expected ms between blocks (for poll interval)

/* ═══════════════════════════════════════════════
   BLOCKCHAIN UTILS
═══════════════════════════════════════════════ */
const h2n = h => (h ? parseInt(h, 16) : 0);

// Single-endpoint RPC call (throws on error)
async function rpcOne(url, method, params) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } finally {
    clearTimeout(tid);
  }
}

// When NodeReal key is set: use NodeReal only.
// Otherwise: round-robin through the public pool with automatic fallback.
async function bscRPC(method, params, nodeRealHttp) {
  if (nodeRealHttp) return rpcOne(nodeRealHttp, method, params);

  // Try up to all pool endpoints before giving up
  const errors = [];
  for (let i = 0; i < BSC_HTTP_POOL.length; i++) {
    const url = nextHttp();
    try {
      return await rpcOne(url, method, params);
    } catch (e) {
      errors.push(`${url.split("/")[2]}: ${e.message}`);
    }
  }
  throw new Error(`所有节点请求失败 — ${errors.slice(0, 2).join(" | ")}`);
}

const fetchBlock   = (tag, http) => bscRPC("eth_getBlockByNumber", [tag, true],  http);
const fetchLatestN = async http  =>
  h2n((await bscRPC("eth_getBlockByNumber", ["latest", false], http))?.number);

// Batch JSON-RPC: fetch up to 20 blocks in one round-trip
async function batchFetchBlocks(blockNums, nodeRealHttp) {
  const url  = nodeRealHttp || nextHttp();
  const body = blockNums.map((n, i) => ({
    jsonrpc: "2.0", method: "eth_getBlockByNumber",
    params: ["0x" + n.toString(16), true], id: i,
  }));
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error("non-batch response");
    return arr.sort((a, b) => a.id - b.id).map(x => x.result || null);
  } finally { clearTimeout(tid); }
}

// Moving-average smoothing on note velocities → more musical dynamics
function smoothNotes(list, win = 5) {
  if (list.length < 2) return list;
  return list.map((n, i) => {
    const lo = Math.max(0, i - Math.floor(win / 2));
    const hi = Math.min(list.length, lo + win);
    const sl = list.slice(lo, hi);
    const avg = key => sl.reduce((s, x) => s + (x[key]?.vel ?? 0), 0) / sl.length;
    return {
      ...n,
      transfer: { ...n.transfer, vel: avg("transfer") },
      defi:     { ...n.defi,     vel: avg("defi")     },
      ambient:  { ...n.ambient,  vel: avg("ambient")  },
      txbeat:   { ...n.txbeat,   vel: Math.max(0,
        sl.reduce((s, x) => s + (x.txbeat?.vel ?? 0), 0) / sl.length) },
    };
  });
}

// Categorize transactions into 3 types by input data
function categorize(block) {
  let transfers = 0, defi = 0, deploys = 0;
  for (const tx of block.transactions || []) {
    if (!tx.to) deploys++;
    else if (tx.input && tx.input !== "0x") defi++;
    else transfers++;
  }
  return { transfers, defi, deploys, total: transfers + defi + deploys };
}

/* ── Voice-leading state (module-level, reset on each playback session) ──
   Tracks last scale index per track so notes move smoothly, ≤2 steps at a time. */
const _vl = {};
function resetVL() { Object.keys(_vl).forEach(k => delete _vl[k]); }

// Return scale index with voice-leading (max ±2 steps per block)
function vlIdx(count, max, scale, trackId) {
  const target = Math.min(
    Math.floor(Math.min(count / max, 1) * scale.length),
    scale.length - 1
  );
  if (_vl[trackId] === undefined) { _vl[trackId] = target; return target; }
  const delta  = target - _vl[trackId];
  const step   = delta === 0 ? 0 : (Math.abs(delta) <= 2 ? delta : Math.sign(delta) * 2);
  _vl[trackId] = _vl[trackId] + step;
  return _vl[trackId];
}

// Map block data → musical notes for all tracks
function toNotes(cats, block, scaleName) {
  const gasUsed  = h2n(block.gasUsed);
  const gasLimit = h2n(block.gasLimit);
  const blockNum = h2n(block.number);
  const util     = gasLimit > 0 ? gasUsed / gasLimit : 0;
  const scale    = SCALES[scaleName].notes;

  const oct = util > 0.65 ? 5 : util > 0.35 ? 4 : 3;
  const vel = Math.max(0.2, Math.min(util * 0.75 + 0.25, 1));

  // ── Voice-led melody (transfer) ──
  const tIdx = vlIdx(cats.transfers, 150, scale, "transfer");
  const tN   = scale[tIdx];

  // ── Harmonic 3rd above transfer (defi) — stays consonant with melody ──
  const dIdx = (tIdx + 2) % scale.length;
  const dN   = scale[dIdx];

  // ── Deploy: voice-led, 1 octave higher for contrast ──
  const pIdx = vlIdx(cats.deploys, 15, scale, "deploy");
  const pN   = scale[pIdx];

  // TX Beat: total tx count → kick drum velocity + pitch decay
  const txNorm  = Math.min(cats.total / 200, 1);
  const txVel   = txNorm < 0.05 ? 0 : Math.max(0.15, txNorm);
  const txPitch = 60 - Math.round(txNorm * 40);   // 60Hz (light) → 20Hz (heavy)
  const txDecay = 0.1 + txNorm * 0.35;

  return {
    transfer: { note: `${tN}${oct}`,               dur: cats.transfers > 100 ? "8n" : "4n", vel,          color: ncolor(tN) },
    defi:     { note: `${dN}${oct}`,               dur: cats.defi > 60 ? "8n" : "4n",       vel: vel*.85, color: ncolor(dN) },
    deploy:   { note: `${pN}${Math.min(oct+1,6)}`, dur: "16n", vel: Math.min(cats.deploys * .15 + .05, 1), color: ncolor(pN) },
    ambient:  { note: `${tN}3`,                    dur: "1n",  vel: util * .3,                color: ncolor(tN) },
    txbeat:   { vel: txVel, pitch: txPitch, decay: txDecay, color: "#ff9f43" },
    isDown:  blockNum % 8 === 0,
    isMid:   blockNum % 4 === 0 && blockNum % 8 !== 0,
    util, blockNum, cats,
  };
}

/* ═══════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════ */
export default function BSCMusicPlayer() {
  // ── State ──
  const [mode,     setMode]    = useState("live");   // "live" | "replay"
  const [playing,  setPlaying] = useState(false);
  const [blocks,   setBlocks]  = useState([]);
  const [cur,      setCur]     = useState(null);
  const [scale,    setScale]   = useState("wholetone");
  const [wsState,  setWsState] = useState("off");    // "off"|"connecting"|"live"|"polling"
  const [bpm,      setBpm]     = useState("--");
  const [err,      setErr]     = useState(null);
  const [latestN,  setLatestN] = useState(null);

  // NodeReal config
  const [nrKey,    setNrKey]   = useState("");       // NodeReal API key
  const [showKey,  setShowKey] = useState(false);    // toggle key visibility

  // Note throttle: play 1 note every N blocks (BSC 450ms → every 4 blocks ≈ 1 note/1.8s)
  const [noteEvery, setNoteEvery] = useState(1); // live default: every block

  // Track mixer
  const [vols, setVols] = useState({ transfer: .8, defi: .6, deploy: .7, ambient: .4, txbeat: .75 });
  const [mute, setMute] = useState({ transfer: false, defi: false, deploy: false, ambient: false, txbeat: false });

  // Replay config
  const [rStart, setRStart] = useState("");
  const [rEnd,   setREnd]   = useState("");
  const [rSpeed, setRSpeed] = useState(4);
  const [rProg,  setRProg]  = useState(null); // { cur, total }

  // Session stats
  const [stats, setStats] = useState({ n: 0, tx: 0, defi: 0, dep: 0 });

  // Live session buffer — stores processed notes for post-session replay
  const liveNotesRef      = useRef([]);
  const [liveBlockCount,  setLiveBlockCount]  = useState(0);
  const [liveReplaySpeed, setLiveReplaySpeed] = useState(4);
  const [liveReplayPlaying, setLiveReplayPlaying] = useState(false);
  const [lrProg, setLrProg] = useState(null); // { cur, total }
  const lrPlayR = useRef(false);

  // Loop & pause (shared between historical replay and live session replay)
  const [loopReplay,      setLoopReplay]      = useState(true);
  const loopReplayR       = useRef(true);
  const [transportPaused, setTransportPaused] = useState(false);

  // Replay notes cache — lets us reschedule at a new speed while paused
  const replayNotesRef        = useRef([]); // smoothed notes for current replay
  const replayIsLiveRef       = useRef(false); // true = live session replay
  const currentReplaySpeedRef = useRef(4);     // speed used for current schedule

  // ── Refs ──
  const audioRef  = useRef(null);
  const wsRef     = useRef(null);
  const timerRef  = useRef(null);
  const playR     = useRef(false);
  const lastNR    = useRef(null);
  const modeR     = useRef(mode);
  const scaleR    = useRef(scale);
  const muteR     = useRef(mute);
  const rStartR   = useRef(rStart);
  const rEndR     = useRef(rEnd);
  const rSpeedR   = useRef(rSpeed);
  const nrKeyR    = useRef(nrKey);   // NodeReal key ref (for stable callbacks)
  const btimes    = useRef([]); // for adaptive BPM

  // Keep refs in sync
  useEffect(() => { modeR.current  = mode;   }, [mode]);
  useEffect(() => { scaleR.current = scale;  }, [scale]);
  useEffect(() => { muteR.current  = mute;   }, [mute]);
  useEffect(() => { rStartR.current = rStart;}, [rStart]);
  useEffect(() => { rEndR.current   = rEnd;  }, [rEnd]);
  useEffect(() => { rSpeedR.current = rSpeed;}, [rSpeed]);
  useEffect(() => { nrKeyR.current  = nrKey; }, [nrKey]);

  const noteEveryR = useRef(noteEvery);
  useEffect(() => { noteEveryR.current = noteEvery; }, [noteEvery]);

  // Auto-switch note throttle when mode changes: live=每块, replay=每4块
  useEffect(() => {
    setNoteEvery(mode === "live" ? 1 : 4);
  }, [mode]);

  // Reset voice-leading when scale changes (different scale = different index space)
  useEffect(() => { resetVL(); }, [scale]);

  useEffect(() => { loopReplayR.current = loopReplay; }, [loopReplay]);

  // Derived: active HTTP + WS URLs based on whether NodeReal key is set
  const activeHttp = nrKey.trim() ? NODEREAL_HTTP(nrKey.trim()) : BSC_HTTP_POOL[0];
  const activeWS   = nrKey.trim() ? NODEREAL_WS(nrKey.trim())   : BSC_WS_FALLBACK;
  const provider   = nrKey.trim() ? "NodeReal" : "PublicNode";

  /* ── Build audio graph (once) ── */
  useEffect(() => {
    const rev = new Tone.Reverb({ decay: 3.5, wet: 0.4 }).toDestination();
    const dly = new Tone.FeedbackDelay({ delayTime: "8n", feedback: .22, wet: .2 }).connect(rev);

    // Per-track volume nodes
    const V = {
      transfer: new Tone.Volume(-7 ).connect(dly),
      defi:     new Tone.Volume(-10).connect(dly),
      deploy:   new Tone.Volume(-8 ).connect(rev),
      ambient:  new Tone.Volume(-20).connect(rev),
      bass:     new Tone.Volume(-14).connect(rev),
      txbeat:   new Tone.Volume(-6 ).toDestination(), // dry kick, no reverb
    };

    // Synths — each with a distinct timbre
    const S = {
      // 💸 Transfers → warm triangle melody
      transfer: new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope: { attack: .05, decay: .5, sustain: .28, release: 2.5 },
      }).connect(V.transfer),

      // 🔮 DeFi/NFT → slightly edgy sawtooth harmony
      defi: new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "sawtooth" },
        envelope: { attack: .02, decay: .3, sustain: .2, release: 1.5 },
      }).connect(V.defi),

      // 🚀 Deploys → metallic percussive hit
      deploy: new Tone.MetalSynth({
        frequency: 200,
        envelope: { attack: .001, decay: .3, release: .15 },
        harmonicity: 3.1, modulationIndex: 16,
        resonance: 3000, octaves: 1.2,
      }).connect(V.deploy),

      // 🌊 Ambient → slow sine pad from gas utilization
      ambient: new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "sine" },
        envelope: { attack: 2, decay: 1, sustain: .6, release: 4 },
      }).connect(V.ambient),

      // 🥁 Bass accent on downbeats
      bass: new Tone.Synth({
        oscillator: { type: "sine" },
        envelope: { attack: .1, decay: .6, sustain: .1, release: 2 },
      }).connect(V.bass),

      // 🥁 TX Beat → MembraneSynth kick, velocity & pitch driven by tx count
      txbeat: new Tone.MembraneSynth({
        pitchDecay: 0.2,
        octaves: 6,
        envelope: { attack: .001, decay: .3, sustain: 0, release: .1 },
      }).connect(V.txbeat),
    };

    audioRef.current = { S, V };

    return () => {
      Object.values(S).forEach(s => s.dispose());
      Object.values(V).forEach(v => v.dispose());
      rev.dispose(); dly.dispose();
    };
  }, []);

  /* ── Sync volumes to audio nodes ── */
  useEffect(() => {
    if (!audioRef.current) return;
    const { V } = audioRef.current;
    Object.entries(vols).forEach(([id, v]) => {
      if (V[id]) V[id].volume.value = v > 0 ? 20 * Math.log10(v) : -Infinity;
    });
  }, [vols]);

  /* ── Sync mutes to audio nodes ── */
  useEffect(() => {
    if (!audioRef.current) return;
    const { V } = audioRef.current;
    Object.entries(mute).forEach(([id, m]) => { if (V[id]) V[id].mute = m; });
  }, [mute]);

  /* ── Play audio for one block's notes ── */
  const playNotes = useCallback(async notes => {
    if (!audioRef.current) return;
    await Tone.start();
    const { S } = audioRef.current;
    const m = muteR.current;
    const now = Tone.now();

    if (!m.transfer)
      S.transfer.triggerAttackRelease(notes.transfer.note, notes.transfer.dur, now, notes.transfer.vel);

    if (!m.defi && notes.cats.defi > 0)
      S.defi.triggerAttackRelease(notes.defi.note, notes.defi.dur, now, notes.defi.vel);

    if (!m.deploy && notes.cats.deploys > 0)
      S.deploy.triggerAttackRelease(notes.deploy.dur, now, notes.deploy.vel);

    if (!m.ambient && notes.ambient.vel > 0.02)
      S.ambient.triggerAttackRelease([notes.ambient.note], "2n", now, notes.ambient.vel);

    // 🥁 TX Beat kick — pitch & decay driven by total tx count
    if (!m.txbeat && notes.txbeat.vel > 0) {
      S.txbeat.set({ pitchDecay: notes.txbeat.decay });
      S.txbeat.triggerAttackRelease(notes.txbeat.pitch, "8n", now, notes.txbeat.vel);
    }

    // Bass accent
    const bassNote = notes.transfer.note.replace(/\d/, "2");
    if (notes.isDown) S.bass.triggerAttackRelease(bassNote, "2n",  now,       0.5);
    else if (notes.isMid) S.bass.triggerAttackRelease(bassNote, "4n", now + .05, 0.3);
  }, []);

  /* ── Play notes at a precise AudioContext time (for Transport scheduling) ── */
  const playNotesAt = useCallback((notes, time) => {
    if (!audioRef.current) return;
    const { S } = audioRef.current;
    const m = muteR.current;

    if (!m.transfer)
      S.transfer.triggerAttackRelease(notes.transfer.note, notes.transfer.dur, time, notes.transfer.vel);

    if (!m.defi && (notes.cats?.defi ?? 0) > 0)
      S.defi.triggerAttackRelease(notes.defi.note, notes.defi.dur, time, notes.defi.vel);

    if (!m.deploy && (notes.cats?.deploys ?? 0) > 0)
      S.deploy.triggerAttackRelease(notes.deploy.dur, time, notes.deploy.vel);

    if (!m.ambient && notes.ambient.vel > 0.02)
      S.ambient.triggerAttackRelease([notes.ambient.note], "2n", time, notes.ambient.vel);

    if (!m.txbeat && notes.txbeat.vel > 0) {
      S.txbeat.set({ pitchDecay: notes.txbeat.decay });
      S.txbeat.triggerAttackRelease(notes.txbeat.pitch, "8n", time, notes.txbeat.vel);
    }

    const bassNote = notes.transfer.note.replace(/\d/, "2");
    if (notes.isDown) S.bass.triggerAttackRelease(bassNote, "2n",  time,        0.5);
    else if (notes.isMid) S.bass.triggerAttackRelease(bassNote, "4n", time + 0.05, 0.3);
  }, []);

  /* ── Process one fetched block → play + update state ── */
  const proc = useCallback(block => {
    const cats    = categorize(block);
    const notes   = toNotes(cats, block, scaleR.current);
    const blockN  = h2n(block.number);

    // ── Adaptive BPM from inter-block timing ──
    const ts = Date.now();
    btimes.current = [...btimes.current.slice(-9), ts];
    if (btimes.current.length >= 2) {
      const deltas = btimes.current.slice(1).map((t, i) => t - btimes.current[i]);
      const avgMs  = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      setBpm(Math.round(60000 / avgMs));
    }

    // ── Note throttle: only play every N blocks ──
    if (blockN % noteEveryR.current === 0) playNotes(notes);

    // Buffer for post-session replay (live mode only)
    liveNotesRef.current.push({ ...notes, _blockN: blockN });
    setLiveBlockCount(c => c + 1);

    setCur({ ...notes, blockN });
    setBlocks(prev => [...prev.slice(-48), { ...notes, blockN: h2n(block.number) }]);
    setStats(prev => ({
      n:   prev.n   + 1,
      tx:  prev.tx  + cats.total,
      defi:prev.defi + cats.defi,
      dep: prev.dep  + cats.deploys,
    }));
    setErr(null);
  }, [playNotes]);

  /* ── Live: polling fallback ── */
  const startPoll = useCallback(() => {
    let busy = false;
    timerRef.current = setInterval(async () => {
      if (!playR.current || busy) return;
      busy = true;
      try {
        const http = nrKeyR.current.trim() ? NODEREAL_HTTP(nrKeyR.current.trim()) : BSC_HTTP_POOL[0];
        const b = await fetchBlock("latest", http);
        if (!b) return;
        const n = h2n(b.number);
        if (n === lastNR.current) return;
        lastNR.current = n;
        proc(b);
      } catch (e) { setErr(`轮询失败: ${e.message}`); }
      finally { busy = false; }
    }, BLOCK_MS);   // poll at ~block rate (450ms)
  }, [proc]);

  /* ── Live: WebSocket (newHeads subscription) ── */
  const startWS = useCallback((wsUrl) => {
    setWsState("connecting");
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState("live");
      ws.send(JSON.stringify({
        jsonrpc: "2.0", method: "eth_subscribe",
        params: ["newHeads"], id: 1,
      }));
    };

    ws.onmessage = async evt => {
      if (!playR.current) return;
      try {
        const msg = JSON.parse(evt.data);
        if (msg.method === "eth_subscription" && msg.params?.result) {
          const hdr  = msg.params.result;
          const n    = h2n(hdr.number);
          if (n === lastNR.current) return;
          lastNR.current = n;
          const http  = nrKeyR.current.trim() ? NODEREAL_HTTP(nrKeyR.current.trim()) : BSC_HTTP_POOL[0];
          const block = await fetchBlock(hdr.number, http);
          if (block) proc(block);
        }
      } catch (e) { console.warn("WS parse error:", e); }
    };

    ws.onerror = () => { setWsState("polling"); startPoll(); };
    ws.onclose = () => {
      wsRef.current = null;
      if (playR.current) { setWsState("polling"); startPoll(); }
    };
  }, [proc, startPoll]);

  /* ── Replay: 3-phase pre-buffered playback via Tone.Transport ──
       Phase 1 (fetching)   : batch-fetch ALL blocks in parallel
       Phase 2 (processing) : convert → notes, apply smoothing
       Phase 3 (playing)    : schedule every note on Transport for jitter-free playback
  ── */
  const startReplay = useCallback(async () => {
    const s = parseInt(rStartR.current);
    const e = parseInt(rEndR.current);
    if (!s || !e || s >= e) {
      setErr("请输入有效的区块范围（起始 < 结束）");
      setPlaying(false);
      return;
    }

    const total   = e - s + 1;
    const BATCH   = 20;        // blocks per JSON-RPC batch
    const CONCUR  = 4;         // parallel batches per wave
    const GROUP   = BATCH * CONCUR;
    const http    = nrKeyR.current.trim() ? NODEREAL_HTTP(nrKeyR.current.trim()) : null;

    // ── Phase 1: Batch-fetch all blocks ────────────────────────────────
    setRProg({ phase: "fetching", cur: 0, total });
    const rawBlocks = new Array(total).fill(null);

    for (let i = 0; i < total; i += GROUP) {
      if (!playR.current) return;
      const wave = [];
      for (let c = 0; c < CONCUR; c++) {
        const from = i + c * BATCH;
        if (from >= total) break;
        const nums = Array.from(
          { length: Math.min(BATCH, total - from) },
          (_, k) => s + from + k
        );
        // Try batch first; fall back to individual fetches on failure
        wave.push(
          batchFetchBlocks(nums, http)
            .catch(async () => {
              // Batch unsupported — fall back to individual fetches
              const results = [];
              const fbHttp = nrKeyR.current.trim()
                ? NODEREAL_HTTP(nrKeyR.current.trim()) : BSC_HTTP_POOL[0];
              for (const n of nums) {
                try { results.push(await fetchBlock("0x" + n.toString(16), fbHttp)); }
                catch { results.push(null); }
              }
              return results;
            })
            .then(blks => {
              const from2 = from; // close over correct value
              blks.forEach((b, k) => { if (b) rawBlocks[from2 + k] = b; });
              setRProg(p => p ? { ...p, cur: Math.min(p.cur + blks.length, total) } : p);
            })
        );
      }
      await Promise.all(wave);
    }
    if (!playR.current) return;

    // ── Phase 2: Process + smooth ──────────────────────────────────────
    setRProg({ phase: "processing", cur: 0, total });
    const validBlocks = rawBlocks.filter(Boolean);
    const notesList   = validBlocks.map(block => ({
      ...toNotes(categorize(block), block, scaleR.current),
      _blockN: h2n(block.number),
    }));
    const smoothed = smoothNotes(notesList);
    if (!playR.current) return;

    // ── Phase 3: Schedule on Tone.Transport ───────────────────────────
    const playCount = smoothed.length;
    setRProg({ phase: "playing", cur: 0, total: playCount });
    setTransportPaused(false);

    // Cache notes so rescheduleReplay() can rebuild at a different speed
    replayNotesRef.current        = smoothed;
    replayIsLiveRef.current       = false;
    currentReplaySpeedRef.current = rSpeedR.current;

    await Tone.start();
    Tone.Transport.cancel();
    Tone.Transport.stop();

    // Each block gets its wall-clock slot: BLOCK_MS / speed (in seconds)
    const secPerBlock = (BLOCK_MS / 1000) / rSpeedR.current;
    const totalDur    = playCount * secPerBlock;
    const doLoop      = loopReplayR.current;

    smoothed.forEach((notes, i) => {
      const t = i * secPerBlock;
      Tone.Transport.schedule(time => {
        if (!playR.current) return;
        playNotesAt(notes, time);
        setCur({ ...notes, blockN: notes._blockN });
        setBlocks(prev => [...prev.slice(-48), { ...notes, blockN: notes._blockN }]);
        setStats(prev => ({
          n:    prev.n    + 1,
          tx:   prev.tx   + (notes.cats?.total   || 0),
          defi: prev.defi + (notes.cats?.defi    || 0),
          dep:  prev.dep  + (notes.cats?.deploys || 0),
        }));
        if (i % 10 === 0 || i === playCount - 1)
          setRProg(p => p ? { ...p, cur: i + 1 } : p);
      }, t);
    });

    if (doLoop) {
      Tone.Transport.loop    = true;
      Tone.Transport.loopEnd = totalDur;
      // Reset progress bar at each loop start
      Tone.Transport.schedule(() => {
        if (playR.current) setRProg(p => p ? { ...p, cur: 0 } : p);
      }, 0.001);
    } else {
      Tone.Transport.loop = false;
      Tone.Transport.schedule(() => {
        if (playR.current) setPlaying(false);
      }, totalDur + 0.5);
    }

    Tone.Transport.start();
  }, [playNotesAt]);

  /* ── Rebuild Transport schedule at a new speed (called when speed changes while paused) ──
     Cancels all existing events, re-schedules the cached notes, leaves Transport stopped
     so the user can resume via the "继续" button from the new speed's t=0. */
  const rescheduleReplay = useCallback((newSpeed) => {
    const notes  = replayNotesRef.current;
    const isLive = replayIsLiveRef.current;
    if (!notes.length) return;

    currentReplaySpeedRef.current = newSpeed;
    const secPerBlock = (BLOCK_MS / 1000) / newSpeed;
    const totalDur    = notes.length * secPerBlock;
    const doLoop      = loopReplayR.current;
    const activeRef   = isLive ? lrPlayR : playR;

    Tone.Transport.cancel();
    Tone.Transport.stop();

    notes.forEach((n, i) => {
      Tone.Transport.schedule(time => {
        if (!activeRef.current) return;
        playNotesAt(n, time);
        setCur({ ...n, blockN: n._blockN });
        setBlocks(prev => [...prev.slice(-48), { ...n, blockN: n._blockN }]);
        if (!isLive) {
          setStats(prev => ({
            n:    prev.n    + 1,
            tx:   prev.tx   + (n.cats?.total   || 0),
            defi: prev.defi + (n.cats?.defi    || 0),
            dep:  prev.dep  + (n.cats?.deploys || 0),
          }));
        }
        if (i % 10 === 0 || i === notes.length - 1) {
          if (isLive) setLrProg(p => p ? { ...p, cur: i + 1 } : p);
          else        setRProg(p => p ? { ...p, cur: i + 1 } : p);
        }
      }, i * secPerBlock);
    });

    if (doLoop) {
      Tone.Transport.loop    = true;
      Tone.Transport.loopEnd = totalDur;
      Tone.Transport.schedule(() => {
        if (activeRef.current) {
          if (isLive) setLrProg(p => p ? { ...p, cur: 0 } : p);
          else        setRProg(p => p ? { ...p, cur: 0 } : p);
        }
      }, 0.001);
    } else {
      Tone.Transport.loop = false;
      Tone.Transport.schedule(() => {
        if (!activeRef.current) return;
        if (isLive) { lrPlayR.current = false; setLiveReplayPlaying(false); }
        else        setPlaying(false);
      }, totalDur + 0.5);
    }

    // Reset progress to 0, keep transportPaused=true
    if (isLive) setLrProg(p => p ? { ...p, cur: 0 } : p);
    else        setRProg(p => p ? { ...p, phase: "playing", cur: 0, total: notes.length } : p);
  }, [playNotesAt]);

  /* ── Pause / resume Transport (works for both replay types) ── */
  const pauseReplay = useCallback(() => {
    try { Tone.Transport.pause(); } catch (_) {}
    setTransportPaused(true);
  }, []);

  const resumeReplay = useCallback(() => {
    try { Tone.Transport.start(); } catch (_) {}
    setTransportPaused(false);
  }, []);

  /* ── Live session replay: smooth + schedule buffered notes on Transport ── */
  const stopLiveReplay = useCallback(() => {
    lrPlayR.current = false;
    setLiveReplayPlaying(false);
    setLrProg(null);
    setTransportPaused(false);
    try { Tone.Transport.stop(); Tone.Transport.cancel(); } catch (_) {}
  }, []);

  const startLiveReplay = useCallback(async () => {
    const notesList = liveNotesRef.current;
    if (notesList.length === 0) return;

    lrPlayR.current = true;
    setLiveReplayPlaying(true);
    setTransportPaused(false);
    setBlocks([]);
    setCur(null);

    // Apply velocity smoothing for a more musical playback
    const smoothed = smoothNotes([...notesList]);
    const total    = smoothed.length;
    setLrProg({ cur: 0, total });

    // Cache notes so rescheduleReplay() can rebuild at a different speed
    replayNotesRef.current        = smoothed;
    replayIsLiveRef.current       = true;
    currentReplaySpeedRef.current = liveReplaySpeed;

    await Tone.start();
    Tone.Transport.cancel();
    Tone.Transport.stop();

    // Speed + loop captured at call time
    const secPerBlock = (BLOCK_MS / 1000) / liveReplaySpeed;
    const totalDur    = total * secPerBlock;
    const doLoop      = loopReplayR.current;

    smoothed.forEach((notes, i) => {
      Tone.Transport.schedule(time => {
        if (!lrPlayR.current) return;
        playNotesAt(notes, time);
        setCur({ ...notes, blockN: notes._blockN });
        setBlocks(prev => [...prev.slice(-48), { ...notes, blockN: notes._blockN }]);
        if (i % 10 === 0 || i === total - 1)
          setLrProg(p => p ? { ...p, cur: (i + 1) % (total + 1) || 1 } : p);
      }, i * secPerBlock);
    });

    if (doLoop) {
      Tone.Transport.loop    = true;
      Tone.Transport.loopEnd = totalDur;
      // Reset progress bar at each loop start
      Tone.Transport.schedule(() => {
        if (lrPlayR.current) setLrProg(p => p ? { ...p, cur: 0 } : p);
      }, 0.001);
    } else {
      Tone.Transport.loop = false;
      Tone.Transport.schedule(() => {
        if (lrPlayR.current) {
          lrPlayR.current = false;
          setLiveReplayPlaying(false);
        }
      }, totalDur + 0.5);
    }

    Tone.Transport.start();
  }, [playNotesAt, liveReplaySpeed]);

  /* ── Master play / stop effect ── */
  useEffect(() => {
    playR.current = playing;

    if (playing) {
      // Stop any running live session replay before starting a new session
      lrPlayR.current = false;
      setLiveReplayPlaying(false);
      setLrProg(null);
      try { Tone.Transport.stop(); Tone.Transport.cancel(); } catch (_) {}

      // Reset state
      resetVL();  // clear voice-leading memory so new session starts fresh
      setStats({ n: 0, tx: 0, defi: 0, dep: 0 });
      setBlocks([]);
      setCur(null);
      setBpm("--");
      lastNR.current = null;
      btimes.current = [];

      if (modeR.current === "live") {
        // Clear live buffer so this session gets its own fresh recording
        liveNotesRef.current = [];
        setLiveBlockCount(0);
        const wsUrl = nrKeyR.current.trim() ? NODEREAL_WS(nrKeyR.current.trim()) : BSC_WS_FALLBACK;
        startWS(wsUrl);
      } else {
        startReplay();
      }
    } else {
      // Cleanup
      clearInterval(timerRef.current);
      clearTimeout(timerRef.current);
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      setWsState("off");
      setRProg(null);
      setTransportPaused(false);
      // Stop Transport (used by replay / live session replay) and cancel all scheduled notes
      try { Tone.Transport.loop = false; Tone.Transport.stop(); Tone.Transport.cancel(); } catch (_) {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  /* ── Fetch latest block number once for UI defaults ── */
  useEffect(() => {
    // Use NodeReal if key is available, otherwise fallback
    const http = nrKey.trim() ? NODEREAL_HTTP(nrKey.trim()) : BSC_HTTP_POOL[0];
    fetchLatestN(http)
      .then(n => {
        setLatestN(n);
        setREnd(String(n));
        setRStart(String(n - BPH));
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setPreset = hours => {
    if (!latestN) return;
    setREnd(String(latestN));
    setRStart(String(latestN - Math.round(hours * BPH)));
  };

  /* ═══════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════ */
  const BG = "linear-gradient(160deg,#060b14 0%,#0a1020 55%,#080c18 100%)";
  const PANEL = { background: "#04080f", border: "1px solid #0e2040", borderRadius: 12 };

  // Track bar height function
  const barHeight = (b, trackId) => {
    if (trackId === "transfer") return 6 + Math.min(b.cats?.transfers || 0, 180) / 180 * 44;
    if (trackId === "defi")     return 6 + Math.min(b.cats?.defi     || 0, 120) / 120 * 44;
    if (trackId === "deploy")   return 6 + Math.min(b.cats?.deploys  || 0,  20) /  20 * 44;
    if (trackId === "txbeat")   return 6 + Math.min(b.cats?.total    || 0, 200) / 200 * 44;
    return 6 + (b.util || 0) * 44; // ambient
  };

  return (
    <div style={{
      background: BG, minHeight: "100vh", color: "#c8d8f0",
      fontFamily: "'Courier New', monospace",
      padding: "22px 18px", boxSizing: "border-box",
      maxWidth: 900, margin: "0 auto",
    }}>

      {/* ══ Header ══ */}
      <div style={{ textAlign: "center", marginBottom: 18 }}>
        <div style={{ fontSize: 9, letterSpacing: 6, color: "#5a8aaa", marginBottom: 4 }}>
          BNB SMART CHAIN
        </div>
        <h1 style={{
          margin: 0, fontSize: 26, letterSpacing: 5, fontWeight: 900,
          background: "linear-gradient(90deg,#00d4ff,#a29bfe,#ff6b6b)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          ⬡ CHAIN MUSIC ⬡
        </h1>
        <p style={{ color: "#5a8aaa", margin: "5px 0 0", fontSize: 10, letterSpacing: 2 }}>
          EVERY BLOCK · A CHORD · 4 TRACKS · LIVE &amp; REPLAY
        </p>
      </div>

      {/* ══ NodeReal RPC Config ══ */}
      <div style={{
        background: "#04080f", border: "1px solid #0e2040",
        borderRadius: 10, padding: "10px 14px", marginBottom: 14,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        {/* Provider badge */}
        <div style={{
          padding: "4px 10px", borderRadius: 5, fontSize: 10, fontWeight: "bold",
          letterSpacing: 1, flexShrink: 0,
          background: nrKey.trim() ? "#0a2010" : "#080e18",
          border: `1px solid ${nrKey.trim() ? "#1dd1a1" : "#5285a5"}`,
          color: nrKey.trim() ? "#1dd1a1" : "#6090b0",
        }}>
          {nrKey.trim() ? "⬡ NodeReal" : "◎ PublicNode"}
        </div>

        {/* Key input */}
        <div style={{ flex: 1, minWidth: 200, position: "relative" }}>
          <input
            value={nrKey}
            onChange={e => setNrKey(e.target.value)}
            disabled={playing}
            type={showKey ? "text" : "password"}
            placeholder="NodeReal API Key（留空使用 PublicNode 免费节点）"
            style={{
              width: "100%", background: "#080e1a",
              border: `1px solid ${nrKey.trim() ? "#1dd1a155" : "#5285a5"}`,
              borderRadius: 6, padding: "6px 32px 6px 9px",
              color: "#a0c0e0", fontSize: 11,
              fontFamily: "monospace", boxSizing: "border-box",
            }}
          />
          <button
            onClick={() => setShowKey(s => !s)}
            style={{
              position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", cursor: "pointer",
              color: "#6090b0", fontSize: 13, padding: 0,
            }}>
            {showKey ? "🙈" : "👁"}
          </button>
        </div>

        {/* Endpoint info */}
        <div style={{ fontSize: 9, color: "#5285a5", flexShrink: 0, lineHeight: 1.6 }}>
          {nrKey.trim() ? (
            <>
              <div><span style={{ color: "#1dd1a166" }}>HTTP → </span>nodereal.io/v1/***</div>
              <div><span style={{ color: "#1dd1a166" }}>WS → </span>nodereal.io/ws/v1/***</div>
            </>
          ) : (
            <>
              <div><span style={{ color: "#5a7aa0" }}>HTTP → </span>公共节点池 ({BSC_HTTP_POOL.length} 个，自动轮换)</div>
              <div><span style={{ color: "#5a7aa0" }}>WS → </span>bsc-rpc.publicnode.com</div>
            </>
          )}
        </div>

        {/* Get API key link hint */}
        {!nrKey.trim() && (
          <div style={{ fontSize: 9, color: "#5285a5", flexShrink: 0 }}>
            🔗 nodereal.io 免费申请<br/>获得稳定专属节点
          </div>
        )}
      </div>

      {/* ══ Mode Selector ══ */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, justifyContent: "center" }}>
        {[["live", "🔴 实时监听"], ["replay", "⏮ 历史回放"]].map(([m, l]) => (
          <button key={m}
            onClick={() => { if (!playing) { setMode(m); setBlocks([]); setCur(null); } }}
            style={{
              background: mode === m ? "#0d2040" : "transparent",
              border: `1px solid ${mode === m ? "#00d4ff" : "#5285a5"}`,
              borderRadius: 8, padding: "8px 22px",
              cursor: playing ? "not-allowed" : "pointer",
              color: mode === m ? "#00d4ff" : "#5a85a5",
              fontSize: 13, letterSpacing: 1,
              opacity: playing && mode !== m ? 0.4 : 1,
            }}>
            {l}
          </button>
        ))}
      </div>

      {/* ══ Replay Panel ══ */}
      {mode === "replay" && (
        <div style={{ ...PANEL, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 9, color: "#5a90b4", letterSpacing: 2, marginBottom: 10 }}>
            REPLAY CONFIGURATION
          </div>

          {/* Preset shortcuts */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#5285a5" }}>快捷：</span>
            {[["2分钟", 2/60], ["5分钟", 5/60], ["15分钟", 15/60], ["30分钟", .5], ["1小时", 1], ["6小时", 6]].map(([l, h]) => (
              <button key={l} onClick={() => setPreset(h)} disabled={playing}
                style={{
                  background: "transparent", border: "1px solid #1a3050",
                  borderRadius: 5, padding: "3px 10px",
                  cursor: playing ? "not-allowed" : "pointer",
                  color: "#6a95b5", fontSize: 10,
                }}>
                {l}
              </button>
            ))}
          </div>

          {/* Block range inputs */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            {[["起始区块", rStart, setRStart], ["结束区块", rEnd, setREnd]].map(([l, v, s]) => (
              <div key={l} style={{ flex: 1, minWidth: 130 }}>
                <div style={{ fontSize: 9, color: "#6090b0", marginBottom: 4 }}>{l}</div>
                <input value={v} onChange={e => s(e.target.value)} disabled={playing}
                  placeholder="区块号..."
                  style={{
                    width: "100%", background: "#080e1a",
                    border: "1px solid #1a3050", borderRadius: 6,
                    padding: "7px 9px", color: "#a0c0e0",
                    fontSize: 12, fontFamily: "monospace", boxSizing: "border-box",
                  }} />
              </div>
            ))}
            <div style={{ minWidth: 100 }}>
              <div style={{ fontSize: 9, color: "#6090b0", marginBottom: 4 }}>回放速度</div>
              <select value={rSpeed}
                onChange={e => {
                  const s = +e.target.value;
                  setRSpeed(s);
                  if (transportPaused) rescheduleReplay(s);
                }}
                disabled={playing && !transportPaused}
                style={{
                  background: "#080e1a", border: "1px solid #1a3050",
                  borderRadius: 6, padding: "7px 9px",
                  color: "#a0c0e0", fontSize: 12, width: "100%",
                  opacity: playing && !transportPaused ? 0.4 : 1,
                }}>
                {[1, 2, 4, 8, 16, 32].map(x => <option key={x} value={x}>{x}x 速</option>)}
              </select>
            </div>

            {/* Loop toggle */}
            <div style={{ minWidth: 60, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              <div style={{ fontSize: 9, color: "#6090b0", marginBottom: 4 }}>模式</div>
              <button onClick={() => setLoopReplay(l => !l)} disabled={playing}
                style={{
                  background: loopReplay ? "#0a0a20" : "transparent",
                  border: `1px solid ${loopReplay ? "#a29bfe" : "#5285a5"}`,
                  borderRadius: 6, padding: "7px 10px",
                  cursor: playing ? "not-allowed" : "pointer",
                  color: loopReplay ? "#a29bfe" : "#6090b0", fontSize: 11,
                }}>
                {loopReplay ? "🔁 循环" : "▶ 单次"}
              </button>
            </div>

            {/* Pause / Resume — visible while playing */}
            {playing && rProg?.phase === "playing" && (
              <div style={{ minWidth: 60, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                <div style={{ fontSize: 9, color: "#6090b0", marginBottom: 4 }}>控制</div>
                <button onClick={transportPaused ? resumeReplay : pauseReplay}
                  style={{
                    background: transportPaused ? "#0a1a0a" : "#0a0a1a",
                    border: `1px solid ${transportPaused ? "#1dd1a1" : "#ffd700"}`,
                    borderRadius: 6, padding: "7px 10px", cursor: "pointer",
                    color: transportPaused ? "#1dd1a1" : "#ffd700", fontSize: 11,
                  }}>
                  {transportPaused ? "▶ 继续" : "⏸ 暂停"}
                </button>
              </div>
            )}
          </div>

          {/* Info row */}
          {latestN && (
            <div style={{ fontSize: 10, color: "#5285a5" }}>
              最新区块 <span style={{ color: "#7ab0c8" }}>#{latestN.toLocaleString()}</span>
              {rStart && rEnd && parseInt(rEnd) > parseInt(rStart) && (
                <> · 共 <span style={{ color: "#00d4ff" }}>
                  {(parseInt(rEnd) - parseInt(rStart)).toLocaleString()}
                </span> 个区块 (~{((parseInt(rEnd) - parseInt(rStart)) / BPH).toFixed(1)}h)</>
              )}
            </div>
          )}

          {/* Progress bar with phase label */}
          {rProg && (
            <div style={{ marginTop: 10 }}>
              {/* Phase label */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{
                  fontSize: 9, letterSpacing: 1, padding: "2px 7px", borderRadius: 4,
                  background: rProg.phase === "fetching" ? "#0a1e10"
                            : rProg.phase === "processing" ? "#1a1400"
                            : "#0a0e20",
                  border: `1px solid ${rProg.phase === "fetching" ? "#1dd1a1"
                                      : rProg.phase === "processing" ? "#ffd700"
                                      : "#a29bfe"}`,
                  color: rProg.phase === "fetching" ? "#1dd1a1"
                       : rProg.phase === "processing" ? "#ffd700"
                       : "#a29bfe",
                }}>
                  {rProg.phase === "fetching"    ? "⬇ 正在下载区块…"
                 : rProg.phase === "processing"  ? "⚙ 正在处理音符…"
                 :                                 "▶ 正在播放"}
                </span>
                <span style={{ fontSize: 9, color: "#6090b0" }}>
                  {rProg.cur.toLocaleString()} / {rProg.total.toLocaleString()}
                  {" "}({Math.round(rProg.cur / rProg.total * 100)}%)
                  {rProg.phase === "playing" && loopReplay && <span style={{ color: "#a29bfe" }}> · 🔁</span>}
                  {rProg.phase === "playing" && transportPaused && <span style={{ color: "#ffd700" }}> · ⏸</span>}
                </span>
              </div>
              {/* Progress track */}
              <div style={{ height: 4, background: "#0e2030", borderRadius: 2, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width: `${(rProg.cur / rProg.total) * 100}%`,
                  background: rProg.phase === "fetching"
                    ? "linear-gradient(90deg,#1dd1a1,#00d4ff)"
                    : rProg.phase === "processing"
                    ? "linear-gradient(90deg,#ffd700,#ff9f43)"
                    : "linear-gradient(90deg,#a29bfe,#00d4ff)",
                  transition: "width .3s ease",
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ Multi-Track Piano Roll ══ */}
      <div style={{ ...PANEL, marginBottom: 12, overflow: "hidden" }}>
        {TRACKS.map(track => (
          <div key={track.id} style={{
            display: "flex", alignItems: "flex-end",
            borderBottom: "1px solid #080e18",
            padding: "6px 10px", height: 60, gap: 2, overflow: "hidden",
          }}>
            {/* Track label */}
            <div style={{ width: 80, flexShrink: 0 }}>
              <div style={{ fontSize: 9, color: mute[track.id] ? "#1a2535" : track.color, letterSpacing: .5 }}>
                {track.emoji} {track.label}
              </div>
              <div style={{ fontSize: 8, color: "#4a6a88" }}>{track.desc}</div>
            </div>

            {/* Note bars */}
            <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 2, overflow: "hidden" }}>
              {blocks.length === 0 ? (
                <div style={{ color: "#4a6a88", fontSize: 10, paddingBottom: 6, paddingLeft: 4 }}>
                  — waiting for blocks —
                </div>
              ) : blocks.map((b, i) => {
                const isLast = i === blocks.length - 1;
                const h = barHeight(b, track.id);
                const c = b[track.id]?.color || track.color;
                return (
                  <div key={b.blockN} style={{
                    width: 11, height: h, background: c,
                    borderRadius: "2px 2px 0 0", flexShrink: 0,
                    opacity: isLast ? 1 : 0.25 + (i / blocks.length) * 0.55,
                    boxShadow: isLast ? `0 0 10px ${c}` : undefined,
                    transition: "height .35s ease",
                  }} />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ══ Stats Strip ══ */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          { l: "区块",     v: cur ? `#${cur.blockN.toLocaleString()}` : "—",           c: "#4a7090" },
          { l: "TX",       v: cur ? cur.cats.total   : "—",                             c: "#c8d8f0" },
          { l: "Transfer", v: cur ? cur.cats.transfers: "—",                            c: "#00d4ff" },
          { l: "DeFi",     v: cur ? cur.cats.defi    : "—",                             c: "#ffd700" },
          { l: "Deploy",   v: cur ? cur.cats.deploys : "—",                             c: "#ff6b6b" },
          { l: "Gas%",     v: cur ? `${Math.round((cur.util || 0) * 100)}%` : "—",     c: "#1dd1a1" },
          { l: "BPM",      v: bpm,                                                      c: "#a29bfe" },
          {
            l: "连接",
            v: mode === "live"
              ? (wsState === "live"
                  ? `${provider} WS ●`
                  : wsState === "polling"
                  ? `${provider} Poll ●`
                  : wsState === "connecting" ? "…" : "—")
              : (rProg?.phase === "fetching"   ? "⬇ 下载"
               : rProg?.phase === "processing" ? "⚙ 处理"
               : rProg?.phase === "playing"    ? "▶ 播放"
               : rProg ? "✓ 完成" : "—"),
            c: wsState === "live" ? "#1dd1a1" : wsState === "polling" ? "#ffd700" : "#6090b0",
          },
        ].map(s => (
          <div key={s.l} style={{
            background: "#080e1a", border: "1px solid #0e2030",
            borderRadius: 7, padding: "7px 10px", flex: "1 1 66px", minWidth: 60,
          }}>
            <div style={{ fontSize: 8, color: "#5285a5", marginBottom: 2, letterSpacing: 1 }}>{s.l}</div>
            <div style={{ fontSize: 15, fontWeight: "bold", color: s.c }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* ══ Track Mixer ══ */}
      <div style={{ ...PANEL, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: "#5285a5", letterSpacing: 2, marginBottom: 10 }}>
          TRACK MIXER
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
          {TRACKS.map(t => (
            <div key={t.id} style={{ textAlign: "center" }}>
              <div style={{
                fontSize: 10, marginBottom: 5,
                color: mute[t.id] ? "#1a2535" : t.color,
              }}>
                {t.emoji} {t.label}
              </div>
              <input
                type="range" min={0} max={1} step={.05}
                value={vols[t.id]}
                onChange={e => setVols(v => ({ ...v, [t.id]: +e.target.value }))}
                style={{ width: "100%", accentColor: t.color, cursor: "pointer" }}
              />
              <div style={{ fontSize: 9, color: "#5285a5", marginBottom: 4 }}>
                {Math.round(vols[t.id] * 100)}%
              </div>
              <button
                onClick={() => setMute(m => ({ ...m, [t.id]: !m[t.id] }))}
                style={{
                  fontSize: 9, padding: "2px 8px",
                  background: mute[t.id] ? "#1a0a0a" : "transparent",
                  border: `1px solid ${mute[t.id] ? "#ff4444" : "#5285a5"}`,
                  borderRadius: 4, cursor: "pointer",
                  color: mute[t.id] ? "#ff6b6b" : "#6090b0",
                }}>
                {mute[t.id] ? "MUTED" : "MUTE"}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ══ Controls ══ */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <button onClick={() => setPlaying(p => !p)} style={{
          background: playing
            ? "linear-gradient(135deg,#c0392b,#922b21)"
            : "linear-gradient(135deg,#00d4ff,#007a99)",
          border: "none", borderRadius: 10, padding: "11px 30px",
          color: "#fff", fontSize: 14, fontWeight: "bold",
          cursor: "pointer", letterSpacing: 3,
          boxShadow: playing ? "0 0 18px #c0392b55" : "0 0 18px #00d4ff55",
        }}>
          {playing ? "⏹  STOP" : "▶  PLAY"}
        </button>

        {/* Scale selector — 2 rows for 8 scales */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, maxWidth: 370 }}>
          {Object.entries(SCALES).map(([k, v]) => (
            <button key={k} onClick={() => setScale(k)} style={{
              background: scale === k ? "#0d2040" : "transparent",
              border: `1px solid ${scale === k ? "#00d4ff" : "#5285a5"}`,
              borderRadius: 7, padding: "5px 10px", cursor: "pointer",
              color: scale === k ? "#00d4ff" : "#5a85a5", fontSize: 10,
              letterSpacing: .5,
            }}>
              {v.label}
            </button>
          ))}
        </div>

        {/* Note throttle — BSC 450ms blocks need throttling */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#6090b0" }}>节奏</span>
          {[1, 2, 4, 8, 16].map(n => (
            <button key={n} onClick={() => setNoteEvery(n)} style={{
              background: noteEvery === n ? "#0d2040" : "transparent",
              border: `1px solid ${noteEvery === n ? "#a29bfe" : "#5285a5"}`,
              borderRadius: 7, padding: "7px 10px", cursor: "pointer",
              color: noteEvery === n ? "#a29bfe" : "#5a85a5", fontSize: 11,
            }}>
              {n === 1 ? "每块" : `每${n}块`}
            </button>
          ))}
          <span style={{ fontSize: 9, color: "#5285a5" }}>
            ≈ {(BLOCK_MS * noteEvery / 1000).toFixed(2)}s/音
          </span>
        </div>
      </div>

      {/* ══ Session Stats ══ */}
      {stats.n > 0 && (
        <div style={{ fontSize: 11, color: "#5285a5", borderTop: "1px solid #08111a", paddingTop: 10 }}>
          已播 <span style={{ color: "#00d4ff" }}>{stats.n}</span> 区块 ·{" "}
          TX <span style={{ color: "#c8d8f0" }}>{stats.tx.toLocaleString()}</span> ·{" "}
          DeFi <span style={{ color: "#ffd700" }}>{stats.defi.toLocaleString()}</span> ·{" "}
          部署 <span style={{ color: "#ff6b6b" }}>{stats.dep}</span>
        </div>
      )}

      {err && <div style={{ color: "#ff4444", fontSize: 11, marginTop: 8 }}>⚠ {err}</div>}

      {/* ══ Live Session Replay Panel ══ */}
      {mode === "live" && !playing && liveBlockCount > 0 && (
        <div style={{ ...PANEL, padding: "12px 14px", marginTop: 12 }}>
          <div style={{ fontSize: 9, color: "#5a90b4", letterSpacing: 2, marginBottom: 10 }}>
            SESSION REPLAY
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {/* Block count badge */}
            <div style={{ fontSize: 11, color: "#7ab0c8", flexShrink: 0 }}>
              🎙 已录制{" "}
              <span style={{ color: "#00d4ff", fontWeight: "bold" }}>
                {liveBlockCount.toLocaleString()}
              </span>{" "}
              区块
              <span style={{ color: "#5285a5" }}>
                {" "}(≈{(liveBlockCount * BLOCK_MS / 1000 / 60).toFixed(1)} 分钟)
              </span>
            </div>

            {/* Speed selector */}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#6090b0" }}>速度</span>
              {[1, 2, 4, 8, 16, 32].map(s => (
                <button key={s}
                  onClick={() => {
                    if (!liveReplayPlaying || transportPaused) {
                      setLiveReplaySpeed(s);
                      if (transportPaused) rescheduleReplay(s);
                    }
                  }}
                  style={{
                    background: liveReplaySpeed === s ? "#120a30" : "transparent",
                    border: `1px solid ${liveReplaySpeed === s ? "#a29bfe" : "#5285a5"}`,
                    borderRadius: 5, padding: "3px 9px",
                    cursor: (liveReplayPlaying && !transportPaused) ? "default" : "pointer",
                    color: liveReplaySpeed === s ? "#a29bfe" : "#5a85a5", fontSize: 10,
                    opacity: (liveReplayPlaying && !transportPaused) ? 0.4 : 1,
                  }}>
                  {s}x
                </button>
              ))}
            </div>

            {/* Loop toggle */}
            <button onClick={() => { if (!liveReplayPlaying) setLoopReplay(l => !l); }}
              style={{
                background: loopReplay ? "#0a0a20" : "transparent",
                border: `1px solid ${loopReplay ? "#a29bfe" : "#5285a5"}`,
                borderRadius: 7, padding: "6px 12px",
                cursor: liveReplayPlaying ? "default" : "pointer",
                color: loopReplay ? "#a29bfe" : "#6090b0", fontSize: 10, flexShrink: 0,
              }}>
              {loopReplay ? "🔁 循环" : "▶ 单次"}
            </button>

            {/* Pause / Resume — only while replaying */}
            {liveReplayPlaying && (
              <button onClick={transportPaused ? resumeReplay : pauseReplay}
                style={{
                  background: transportPaused ? "#0a1a0a" : "#0a0a1a",
                  border: `1px solid ${transportPaused ? "#1dd1a1" : "#ffd700"}`,
                  borderRadius: 7, padding: "6px 14px", cursor: "pointer",
                  color: transportPaused ? "#1dd1a1" : "#ffd700", fontSize: 11,
                  fontWeight: "bold", flexShrink: 0,
                }}>
                {transportPaused ? "▶ 继续" : "⏸ 暂停"}
              </button>
            )}

            {/* Play / Stop button */}
            <button
              onClick={liveReplayPlaying ? stopLiveReplay : startLiveReplay}
              style={{
                background: liveReplayPlaying
                  ? "linear-gradient(135deg,#c0392b,#922b21)"
                  : "linear-gradient(135deg,#a29bfe,#6c5ce7)",
                border: "none", borderRadius: 8, padding: "7px 18px",
                color: "#fff", fontSize: 12, fontWeight: "bold",
                cursor: "pointer", letterSpacing: 1, flexShrink: 0,
                boxShadow: liveReplayPlaying ? "0 0 14px #c0392b55" : "0 0 14px #a29bfe55",
              }}>
              {liveReplayPlaying ? "⏹ 停止" : "⏮ 回放本次"}
            </button>
          </div>

          {/* Progress bar */}
          {lrProg && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 9, color: "#6090b0", marginBottom: 3 }}>
                {lrProg.cur.toLocaleString()} / {lrProg.total.toLocaleString()}
                {" "}({Math.round(lrProg.cur / lrProg.total * 100)}%)
                {loopReplay && <span style={{ color: "#a29bfe" }}> · 🔁 循环中</span>}
                {transportPaused && <span style={{ color: "#ffd700" }}> · ⏸ 已暂停</span>}
              </div>
              <div style={{ height: 3, background: "#0e2030", borderRadius: 2, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width: `${(lrProg.cur / lrProg.total) * 100}%`,
                  background: transportPaused
                    ? "linear-gradient(90deg,#ffd700,#ff9f43)"
                    : "linear-gradient(90deg,#a29bfe,#6c5ce7)",
                  transition: "width .2s ease",
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ Legend ══ */}
      <div style={{
        marginTop: 20, fontSize: 10, color: "#3a5a78", lineHeight: 2.2,
        borderTop: "1px solid #080e18", paddingTop: 12,
      }}>
        <div style={{ color: "#5285a5", letterSpacing: 2, marginBottom: 2 }}>MAPPING RULES</div>
        <div>💸 Transfer 数 → 旋律音高 (Triangle)  ·  🔮 DeFi 调用数 → 和声 (Sawtooth)</div>
        <div>🚀 合约部署数 → 金属打击 (Metal Synth)  ·  🌊 Gas 利用率 → 环境声 (Sine Pad)</div>
        <div>🥁 TX总数 → 底鼓节拍 (Membrane Synth)：交易越多，底鼓越重越低沉</div>
        <div>🎵 声部引导：音符每次最多移动2阶，DeFi轨自动跟随Transfer三度音程</div>
        <div>🎛 BPM 自动适应出块速度  ·  📡 WSS 实时 + 轮询兜底  ·  ⏮ 历史回放预加载 3阶段</div>
      </div>
    </div>
  );
}
