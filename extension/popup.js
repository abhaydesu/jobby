const DEFAULT_SERVER = 'http://127.0.0.1:3456';

function setStatus(msg, isErr = false) {
  const box = document.getElementById('status-box');
  box.style.display = 'block';
  box.style.borderColor = isErr ? '#ef4444' : '#3b82f6';
  box.textContent = msg;
}

async function resolveConfig() {
  const stored = await chrome.storage.local.get(['serverUrl', 'ingestToken']);
  const serverUrl = (stored.serverUrl || DEFAULT_SERVER).replace(/\/$/, '');
  let ingestToken = stored.ingestToken || '';
  if (!ingestToken) {
    try {
      const cfg = await fetch(`${serverUrl}/api/ingest/config`).then((r) => r.json());
      if (cfg.ingestToken) {
        ingestToken = cfg.ingestToken;
        await chrome.storage.local.set({ serverUrl, ingestToken });
      }
    } catch {
      ingestToken = '';
    }
  }
  return { serverUrl, ingestToken };
}

document.getElementById('btn-capture').addEventListener('click', async () => {
  const btn = document.getElementById('btn-capture');
  btn.disabled = true;
  setStatus('Scanning active tab...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');
    const extracted = await chrome.tabs.sendMessage(tab.id, { action: 'CAPTURE_PAGE' });
    if (!extracted?.ok) throw new Error(extracted?.error || 'Open a supported job site tab first.');
    if (!extracted.jobs?.length) {
      setStatus('No job cards detected on this view. Scroll or open a jobs list.');
      btn.disabled = false;
      return;
    }

    const { serverUrl, ingestToken } = await resolveConfig();
    if (!ingestToken) throw new Error('Missing ingest token. Open Settings to configure.');

    const res = await fetch(`${serverUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Jobby-Token': ingestToken,
      },
      body: JSON.stringify({
        sourceTag: extracted.sourceTag,
        pageUrl: extracted.pageUrl,
        jobs: extracted.jobs,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setStatus(`Captured ${data.received} roles (${data.newCount} new, ${data.updatedCount} updated).`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
