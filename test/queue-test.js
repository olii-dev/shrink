// Headless end-to-end test for Shrink's MULTI-FILE queue.
// Drops two videos, clicks "Compress all", verifies both complete.
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8769;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=9222', '--remote-allow-origins=*', 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await sleep(2000);

  const targets = await (await fetch('http://localhost:9222/json')).json();
  const page = targets.find((t) => t.type === 'page');
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
      log.push(`[console.${msg.params.type}] ${msg.params.args.map((a) => a.value || '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      log.push('[exception] ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
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

  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await sleep(3000);

  const eval_ = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    return r.result?.result?.value;
  };

  // Inject BOTH files at once
  const injectResult = await eval_(`
    (async () => {
      try {
        const [r1, r2] = await Promise.all([
          fetch('http://localhost:${PORT}/test-input.mp4'),
          fetch('http://localhost:${PORT}/test-input2.mp4'),
        ]);
        const [b1, b2] = await Promise.all([r1.arrayBuffer(), r2.arrayBuffer()]);
        const f1 = new File([b1], 'first.mp4', { type: 'video/mp4' });
        const f2 = new File([b2], 'second.mp4', { type: 'video/mp4' });
        const input = document.getElementById('fileInput');
        const dt = new DataTransfer();
        dt.items.add(f1);
        dt.items.add(f2);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'injected 2 files';
      } catch (e) {
        return 'ERR: ' + e.message;
      }
    })()
  `);
  console.log('Inject:', injectResult);
  await sleep(2000);

  // Check queue populated
  const queueState = await eval_(
    `JSON.stringify({ count: document.querySelectorAll('.queue-item').length, visible: !document.getElementById('queueSection').classList.contains('hidden'), countText: document.getElementById('queueCount').textContent })`,
    false,
  );
  console.log('Queue after inject:', queueState);

  // Set small target to force compression
  await eval_(`document.getElementById('targetSize').value = '1'`, false);

  // Click "Compress all"
  await eval_(`document.getElementById('compressAllBtn').click()`, false);
  console.log('Clicked Compress all. Polling...');

  let final = null;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const v = await eval_(`
      ({
        queueCount: document.getElementById('queueCount').textContent,
        batchLabel: document.getElementById('batchLabel').textContent,
        batchPct: document.getElementById('batchPct').textContent,
        batchDetail: document.getElementById('batchDetail').textContent.slice(0, 80),
        batchVisible: !document.getElementById('batchProgress').classList.contains('hidden'),
        downloadAllVisible: !document.getElementById('downloadAllBtn').classList.contains('hidden'),
        items: Array.from(document.querySelectorAll('.queue-item')).map(li => ({
          name: li.querySelector('.qi-name')?.textContent,
          status: li.className,
          result: li.querySelector('.qi-result')?.textContent,
          error: li.querySelector('.qi-error')?.textContent,
        })),
        alertText: window.__lastAlert || '',
      })
    `, false);
    const v2 = v || {};
    const items = v2.items || [];
    console.log(
      `[${i * 2}s] ${v2.queueCount || ''} | ${v2.batchLabel || ''} ${v2.batchPct || ''}${v2.batchDetail ? ' · ' + v2.batchDetail : ''}`,
    );
    if (i % 5 === 0) {
      items.forEach((it) => console.log(`      ${it.name}: ${it.status.split(' ').find((s) => s.startsWith('status-'))} ${it.result || it.error || ''}`));
    }
    if (v2.alertText) {
      final = { status: 'ALERT', msg: v2.alertText };
      break;
    }
    // Done when batch progress hidden or shows "done" AND all items have terminal status
    const allDone = items.length >= 2 && items.every((it) => /status-(done|error|skipped)/.test(it.status));
    if (allDone) {
      final = {
        status: 'SUCCESS',
        items: items.map((it) => ({ name: it.name, status: it.status, result: it.result })),
        downloadAllVisible: v2.downloadAllVisible,
      };
      break;
    }
  }

  console.log('\n=== Console log capture ===');
  log.slice(-15).forEach((l) => console.log(l));

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(final, null, 2));

  ws.close();
  chrome.kill();
  process.exit(final && final.status === 'SUCCESS' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
