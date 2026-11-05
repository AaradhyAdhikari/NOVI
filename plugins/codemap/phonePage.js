// graphify's page is made for a big screen: on a phone its 280 px panel left the map a thin strip (live
// 2026-11-05). The phone gets a copy where the map fills the screen and the panel slides in: from the
// Details button, or by tapping a dot. Only added to, so a new graphify page keeps working.
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

const STYLE = `<style>
#novi-details { display: none; }
@media (max-width: 700px) {
  #graph { width: 100vw; flex: 1 1 100%; }
  #sidebar { position: fixed; top: 0; right: 0; bottom: 0; width: 86vw; max-width: 340px; padding-top: 44px; z-index: 20;
    transform: translateX(100%); transition: transform .2s ease; }
  body.novi-open #sidebar { transform: none; }
  #novi-details { display: block; position: fixed; bottom: 56px; right: 12px; z-index: 30; padding: 10px 16px; border-radius: 20px;
    border: 1px solid var(--input-border); background: var(--panel); color: var(--text); font-size: 14px; }
}
</style>`;

const SCRIPT = `<button id="novi-details" type="button">Details</button>
<script>
(function () {
  var button = document.getElementById('novi-details');
  function show(open) {
    document.body.classList.toggle('novi-open', open);
    button.textContent = open ? 'Close' : 'Details';
  }
  button.addEventListener('click', function () { show(!document.body.classList.contains('novi-open')); });
  network.on('selectNode', function () { if (window.innerWidth <= 700) show(true); });
  // The map was first drawn around the panel's space.
  setTimeout(function () { network.redraw(); network.fit(); }, 400);
})();
</script>`;

export function phonePage(html) {
  const head = /name=["']viewport["']/.test(html) ? STYLE : `${VIEWPORT}${STYLE}`;
  return html.replace('</head>', () => `${head}</head>`).replace(/<\/body>(?![\s\S]*<\/body>)/, () => `${SCRIPT}</body>`);
}
