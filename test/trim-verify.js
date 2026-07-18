// Verify trim output duration: set trim 2-5s, compress, save output, check duration ≈ 3s.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=9222', '--remote-allow-origins=*', 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

(async () => {
  await sleep(2000);
  const targets = await (await fetch('http://localhost:9222/json')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const cid = id++;
      pending.set(cid, r);
      ws.send(JSON.stringify({ id: cid, method, params }));
    });
  const eval_ = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://localhost:8769/' });
  await sleep(3000);

  await eval_(`(async()=>{
    const r = await fetch('http://localhost:8769/test-input.mp4');
    const b = await r.arrayBuffer();
    const f = new File([b],'t.mp4',{type:'video/mp4'});
    const i = document.getElementById('fileInput');
    const d = new DataTransfer(); d.items.add(f); i.files = d.files;
    i.dispatchEvent(new Event('change',{bubbles:true}));
    return 'ok';
  })()`);
  await sleep(2000);

  await eval_(`(()=>{
    const item = queue[0];
    toggleTrimPanel(item);
    item.trimStart = 2; item.trimEnd = 5;
    updateTrimReadout(item);
  })()`, false);
  await eval_(`document.getElementById('targetSize').value = '10'`, false);
  await eval_(`document.getElementById('compressAllBtn').click()`, false);

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = await eval_(`document.querySelector('.queue-item')?.className || ''`, false);
    if (s.includes('status-done')) break;
  }

  const b64 = await eval_(`(async()=>{
    const v = queue[0];
    if (!v.resultUrl) return null;
    const r = await fetch(v.resultUrl);
    const b = await r.arrayBuffer();
    const bytes = new Uint8Array(b);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  })()`);

  if (b64) {
    fs.writeFileSync('test-output.mp4', Buffer.from(b64, 'base64'));
    console.log('saved output (' + (b64.length * 0.75 / 1024 / 1024).toFixed(2) + ' MB)');
  } else {
    console.log('NO OUTPUT');
  }

  ws.close();
  chrome.kill();
  process.exit(b64 ? 0 : 1);
})();
