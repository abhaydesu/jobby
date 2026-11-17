const DEFAULT_SERVER = 'http://127.0.0.1:3456';

async function loadOptions() {
  const data = await chrome.storage.local.get(['serverUrl', 'ingestToken']);
  document.getElementById('server-url').value = data.serverUrl || DEFAULT_SERVER;
  document.getElementById('ingest-token').value = data.ingestToken || '';
}

document.getElementById('btn-sync').addEventListener('click', async () => {
  const url = (document.getElementById('server-url').value || DEFAULT_SERVER).replace(/\/$/, '');
  const msg = document.getElementById('save-msg');
  try {
    const res = await fetch(`${url}/api/ingest/config`);
    const data = await res.json();
    if (!res.ok || !data.ingestToken) throw new Error(data.error || 'Could not retrieve token');
    document.getElementById('ingest-token').value = data.ingestToken;
    await chrome.storage.local.set({ serverUrl: url, ingestToken: data.ingestToken });
    msg.textContent = 'Synced shared token from local Jobby server.';
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById('btn-save').addEventListener('click', async () => {
  const serverUrl = (document.getElementById('server-url').value || DEFAULT_SERVER).replace(/\/$/, '');
  const ingestToken = document.getElementById('ingest-token').value.trim();
  await chrome.storage.local.set({ serverUrl, ingestToken });
  document.getElementById('save-msg').textContent = 'Settings saved.';
});

loadOptions();
