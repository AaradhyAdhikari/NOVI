const $ = (id) => document.getElementById(id);
chrome.runtime.sendMessage('status', (r) => { $('status').textContent = r ? `— ${r.status}` : ''; });
$('save').addEventListener('click', async () => {
  const code = $('code').value.trim();
  if (!code) return;
  await chrome.storage.local.set({ code });
  $('status').textContent = '— saved, connecting…';
  $('code').value = '';
});
