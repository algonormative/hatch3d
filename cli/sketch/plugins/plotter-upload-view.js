/** Loaded only when the local sketch server explicitly enables the upload plugin. */
const exportButton = document.getElementById('download');
const actions = document.querySelector('.header-actions');
if (exportButton && actions) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet';
  button.textContent = 'Upload to plotter queue';
  button.disabled = true;
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.fontSize = '0.8rem';
  actions.append(button, status);
  let sending = false;
  let lastQueuedIdentity = null;
  const sync = () => { button.disabled = sending || exportButton.disabled; };
  new MutationObserver(sync).observe(exportButton, { attributes: true, attributeFilter: ['disabled'] });
  sync();
  button.addEventListener('click', async () => {
    if (button.disabled || exportButton.disabled || sending) return;
    sending = true;
    sync();
    status.textContent = 'Uploading…';
    try {
      // No request occurs on page load. The viewer supplies this tab's current identity, never SVG or URL.
      const identity = exportButton.dataset.identity;
      if (!identity || exportButton.disabled) throw new Error('Current successful render unavailable');
      const response = await fetch('/api/plugins/plotter-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sketch-action': 'plotter-upload' },
        body: JSON.stringify({ identity }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Upload failed');
      lastQueuedIdentity = identity;
      status.textContent = `Queued ${payload.id}`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Upload failed';
    } finally {
      sending = false;
      sync();
    }
  });
  // Status is tied to the selected render; a new successful render can be queued separately.
  new MutationObserver(() => { if (exportButton.disabled && lastQueuedIdentity) status.textContent = ''; })
    .observe(exportButton, { attributes: true, attributeFilter: ['disabled'] });
}
