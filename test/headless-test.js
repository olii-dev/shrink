// Headless end-to-end test for Shrink via Chrome DevTools Protocol.
// Connects to the PAGE target (not browser), dispatches a real File, and polls.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8769;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-debugging-port=9222',
      '--remote-allow-origins=*',
      `about:blank`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  await sleep(2000);

  // List targets, grab the first page
  const targets = await (await fetch('http://localhost:9222/json')).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  console.log('Connected to page target');

  let msgId = 1;
  const pending = new Map();
  const log = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const args = msg.params.args.map((a) => a.value || a.description || '').join(' ');
      log.push(`[console.${msg.params.type}] ${args}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      log.push('[exception] ' + JSON.stringify(msg.params.exceptionDetails));
    } else if (msg.method === 'Log.entryAdded') {
      log.push('[log] ' + JSON.stringify(msg.params.entry));
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = msgId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await sleep(3000);

  const eval_ = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    return r.result?.result?.value;
  };

  // Dispatch a real File onto the input
  const injectResult = await eval_(`
    (async () => {
      try {
        const resp = await fetch('http://localhost:${PORT}/test-input.mp4');
        const buf = await resp.arrayBuffer();
        const file = new File([buf], 'test-input.mp4', { type: 'video/mp4' });
        const input = document.getElementById('fileInput');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      } catch (e) {
        return 'ERR: ' + e.message + ' // ' + e.stack;
      }
    })()
  `);
  console.log('Inject:', injectResult);
  await sleep(3000);

  const cfg = await eval_(
    `document.getElementById('config').classList.contains('hidden') ? 'hidden' : 'visible'`,
    false,
  );
  console.log('Config section:', cfg);
  const sizeText = await eval_(`document.getElementById('fileSize').textContent`, false);
  console.log('Detected size:', sizeText);
  const durText = await eval_(`document.getElementById('fileDuration').textContent`, false);
  console.log('Detected duration:', durText);

  // Optional: override target size + resolution via env vars (for testing joke modes)
  const targetSize = process.env.TARGET_MB;
  const resolution = process.env.RESOLUTION_H;
  if (targetSize) {
    await eval_(`document.getElementById('targetSize').value = '${targetSize}'`, false);
    console.log('Set target size:', targetSize, 'MB');
  }
  if (resolution) {
    await eval_(`document.getElementById('resolution').value = '${resolution}'`, false);
    console.log('Set resolution height:', resolution, 'p');
  }

  // Click compress
  await eval_(`document.getElementById('compressBtn').click()`, false);
  console.log('Clicked compress. Polling...');

  let final = null;
  for (let i = 0; i < 180; i++) {  // up to 6 minutes for slow WASM encoding
    await sleep(2000);
    const v = await eval_(`
      ({
        progressVisible: !document.getElementById('progress').classList.contains('hidden'),
        resultVisible: !document.getElementById('result').classList.contains('hidden'),
        progressLabel: document.getElementById('progressLabel').textContent,
        progressPct: document.getElementById('progressPct').textContent,
        progressDetail: document.getElementById('progressDetail').textContent,
        afterSize: document.getElementById('afterSize').textContent,
        savedPct: document.getElementById('savedPct').textContent,
        alertText: window.__lastAlert || '',
      })
    `, false);
    console.log(
      `[${i * 2}s] ${v.progressLabel || ''} ${v.progressPct || ''}${v.progressDetail ? ' · ' + v.progressDetail.slice(0, 100) : ''}`,
    );
    if (v.alertText) {
      final = { status: 'ALERT', msg: v.alertText };
      break;
    }
    if (v.resultVisible) {
      final = { status: 'SUCCESS', after: v.afterSize, saved: v.savedPct };
      break;
    }
  }

  console.log('\n=== Console log capture ===');
  log.slice(-30).forEach((l) => console.log(l));

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(final, null, 2));

  // If success, download the output and verify it has audio + video
  if (final && final.status === 'SUCCESS') {
    const base64 = await eval_(`
      (async () => {
        const v = document.getElementById('resultVideo');
        if (!v.src) return null;
        const resp = await fetch(v.src);
        const buf = await resp.arrayBuffer();
        // base64 encode
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      })()
    `);
    if (base64) {
      const outPath = path.join(__dirname, '..', 'test-output.mp4');
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      const stat = fs.statSync(outPath);
      console.log(`\nSaved output to ${outPath} (${stat.size} bytes)`);
    }
  }

  ws.close();
  chrome.kill();
  process.exit(final && final.status === 'SUCCESS' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
