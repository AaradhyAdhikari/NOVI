const $ = (id) => document.getElementById(id);
// The live state, every second (connecting → checking the code → connected, or why not).
const show = () => chrome.runtime.sendMessage('status', (r) => { $('status').textContent = r ? `— ${r.status}` : ''; });
show();
setInterval(show, 1000);
$('save').addEventListener('click', async () => {
  const code = $('code').value.trim();
  if (!code) return;
  await chrome.storage.local.set({ code });
  $('status').textContent = '— saved, connecting…';
  setTimeout(show, 300);
  $('code').value = '';
});
