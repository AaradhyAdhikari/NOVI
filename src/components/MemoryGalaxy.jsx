import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search } from 'lucide-react';

// Settings → Memory: the notes in Documents\Novi Memory as a galaxy. Each note is a star coloured
// by folder and sized by its links; tap one to fly to it and read it. Narrow screens get a list.
// The note text is shown as plain text (<pre>), never as HTML.
const COLORS = { Notes: '#00f2fe', Actions: '#ffb547', Home: '#e8ecf4', Shortcuts: '#7cf29a' };
const colorOf = (folder) => COLORS[folder] || '#b18cff';
const NARROW = 600;

export default function MemoryGalaxy({ api, onClose }) {
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null); // { id, title, text }
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW);
  const box = useRef(null);
  const fg = useRef(null);
  const focus = useRef(null); // the clicked node and its neighbours

  useEffect(() => {
    api('/api/wiki/graph').then((r) => r.json()).then(setGraph).catch(() => setError('Could not load your notes.'));
    const onResize = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [api]);

  const degree = useMemo(() => {
    const d = {};
    for (const l of graph?.links || []) { d[l.source] = (d[l.source] || 0) + 1; d[l.target] = (d[l.target] || 0) + 1; }
    return d;
  }, [graph]);

  async function show(node) {
    if (!node) return;
    // Learned shortcuts aren't files: their dot already says what they do.
    if (node.folder === 'Shortcuts') { setOpen({ id: node.id, title: node.title, text: node.excerpt || '' }); return; }
    try {
      const res = await api(`/api/wiki/note?id=${encodeURIComponent(node.id)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setOpen({ id: node.id, ...body });
    } catch (err) {
      setOpen({ id: node.id, title: node.title, text: err.message || 'Could not open that note.' });
    }
  }

  function flyTo(node) {
    const g = fg.current;
    if (!g || node.x === undefined) return;
    const near = new Set([node.id]);
    for (const l of g.graphData().links) {
      const s = l.source.id ?? l.source;
      const t = l.target.id ?? l.target;
      if (s === node.id) near.add(t);
      if (t === node.id) near.add(s);
    }
    focus.current = near;
    g.centerAt(node.x, node.y, 800);
    g.zoom(3, 800);
  }

  useEffect(() => {
    if (narrow || !graph || !box.current) return undefined;
    let g;
    let cancelled = false;
    import('force-graph').then(({ default: ForceGraph }) => {
      if (cancelled || !box.current) return;
      const el = box.current;
      g = new ForceGraph(el)
        .width(el.clientWidth)
        .height(el.clientHeight)
        .backgroundColor('#05070d')
        .graphData({ nodes: graph.nodes.map((n) => ({ ...n })), links: graph.links.map((l) => ({ ...l })) })
        .nodeId('id')
        .nodeLabel((n) => `${n.title}${n.updated ? ` · ${n.updated}` : ''}`)
        .nodeVal((n) => 2 + 2 * (degree[n.id] || 0))
        .nodeCanvasObject((n, ctx, scale) => {
          const dim = focus.current && !focus.current.has(n.id);
          const r = Math.sqrt(2 + 2 * (degree[n.id] || 0)) * 2;
          ctx.globalAlpha = dim ? 0.2 : 1;
          ctx.shadowColor = colorOf(n.folder);
          ctx.shadowBlur = 12;
          ctx.fillStyle = colorOf(n.folder);
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
          ctx.fill();
          ctx.shadowBlur = 0;
          if (scale > 1.2 || !dim) {
            ctx.font = `${11 / scale}px Inter, sans-serif`;
            ctx.fillStyle = '#c9d1e0';
            ctx.textAlign = 'center';
            ctx.fillText(n.title, n.x, n.y + r + 10 / scale);
          }
          ctx.globalAlpha = 1;
        })
        .linkColor((l) => (focus.current && focus.current.has(l.source.id) && focus.current.has(l.target.id) ? 'rgba(0,242,254,.7)' : 'rgba(138,148,168,.25)'))
        .d3AlphaDecay(0.01)
        .onNodeClick((n) => { flyTo(n); show(n); })
        .onBackgroundClick(() => { focus.current = null; setOpen(null); });
      fg.current = g;
    }).catch(() => setError('Could not draw the galaxy.'));
    const onResize = () => box.current && g?.width(box.current.clientWidth).height(box.current.clientHeight);
    window.addEventListener('resize', onResize);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      g?._destructor?.();
      fg.current = null;
    };
  }, [graph, narrow, degree]); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = (graph?.nodes || []).filter((n) => !query || n.title.toLowerCase().includes(query.toLowerCase()));
  function search(e) {
    e.preventDefault();
    const hit = matches[0];
    if (!hit) return;
    const live = fg.current?.graphData().nodes.find((n) => n.id === hit.id);
    if (live) flyTo(live);
    show(hit);
  }

  return (
    <div className="galaxy">
      <div className="galaxy-head">
        <form className="galaxy-search" onSubmit={search}>
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a note" aria-label="Find a note" />
        </form>
        <button className="icon" aria-label="Close memory" onClick={onClose}><X size={18} /></button>
      </div>
      {error && <p className="muted galaxy-msg">{error}</p>}
      {graph && graph.nodes.length === 0 && <p className="muted galaxy-msg">No notes yet. Say “note that …” and they'll appear here.</p>}
      {narrow ? (
        <ul className="galaxy-list">
          {matches.map((n) => (
            <li key={n.id}>
              <button onClick={() => show(n)}>
                <span className="dot" style={{ background: colorOf(n.folder) }} />
                <strong>{n.title}</strong>
                <span className="muted">{n.excerpt}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="galaxy-canvas" ref={box} />
      )}
      {open && (
        <aside className="galaxy-note">
          <div className="galaxy-head">
            <h3>{open.title}</h3>
            <button className="icon" aria-label="Close note" onClick={() => setOpen(null)}><X size={16} /></button>
          </div>
          <pre>{open.text}</pre>
        </aside>
      )}
    </div>
  );
}
