import { app, nativeImage } from 'electron';
import { createServer } from 'node:net';
import path from 'node:path';
import { SettingsStore, DEFAULT_SETTINGS } from '../dist-electron/settings.js';
import { createAgentConversation, runAgent } from '../dist-electron/agent.js';
import { markCaptureCursor } from '../dist-electron/capture-marker.js';

async function main() {
app.setPath('userData', path.join(app.getPath('appData'), 'rabbitball'));
// 密钥仅经本机管道进入内存，本机配置只保存系统加密后的密文。
const apiKey = await new Promise(resolve => {
  const server = createServer(socket => {
    let value = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { value += chunk; if (value.includes('\n')) { socket.end(); server.close(); resolve(value.trim()); } });
  });
  server.listen('\\\\.\\pipe\\rabbitball-live-check', () => console.log('Ready for local test input.'));
});
await app.whenReady();
try {
  const store = new SettingsStore();
  await store.load();
  await store.save({ apiKey });
  // 使用公开公式绘制测试图，不采集用户桌面。
  const width = 640, height = 360, bitmap = Buffer.alloc(width * height * 4, 255);
  const glyphs = { F:['11111','10000','10000','11110','10000','10000','10000'], '=':['00000','00000','11111','00000','11111','00000','00000'], m:['00000','00000','11011','10101','10101','10101','10101'], a:['00000','00000','01110','00001','01111','10001','01111'] };
  let left = 86;
  for (const letter of 'F=ma') {
    glyphs[letter].forEach((row,y) => [...row].forEach((pixel,x) => {
      if(pixel !== '1') return;
      for(let dy=0;dy<10;dy++) for(let dx=0;dx<10;dx++) {
        const index = ((110+y*10+dy)*width+left+x*10+dx)*4;
        bitmap[index]=bitmap[index+1]=bitmap[index+2]=32;
      }
    }));
    left += 70;
  }
  const image = nativeImage.createFromBitmap(bitmap,{width,height,scaleFactor:1});
  const size = image.getSize();
  const cursor = { x: 190, y: 140, width: size.width, height: size.height, inside: true };
  const marked = markCaptureCursor(image, cursor, DEFAULT_SETTINGS.eyeColor);
  const context = { id: 'public-formula-fixture', title: 'Formula test', capturedAt: Date.now(),
    images: [{ id:'public-formula-image', title:'Formula test', cursor, imageDataUrl: 'data:image/jpeg;base64,' + marked.toJPEG(90).toString('base64') }] };
  const results = [], conversation = createAgentConversation();
  const nativeFetch = globalThis.fetch;
  let firstPrefix = null, prefixReused = false, imageCounts = [];
  globalThis.fetch = async (input, init) => {
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body);
      if (Array.isArray(body.messages)) {
        imageCounts.push(body.messages.reduce((sum,message)=>sum+(Array.isArray(message.content)?message.content.filter(part=>part.type==='image_url').length:0),0));
        if (firstPrefix) prefixReused ||= JSON.stringify(body.messages.slice(0,firstPrefix.length))===JSON.stringify(firstPrefix);
      }
    }
    return nativeFetch(input, init);
  };
  const steps = [
    { action:'search', turnId:'formula', text:'搜索并简短解释鼠标圆环附近的公式。', context },
    { action:'ask', turnId:'follow-up', text:'质量不变时，合力变为两倍，加速度会怎样？只用一句话回答。' },
    { action:'ask', turnId:'follow-up', regenerate:true, text:'质量不变时，合力变为两倍，加速度会怎样？只用一句话回答。' },
  ];
  for (const step of steps) {
    let answer = '', tools = 0, failure;
    await runAgent({ id: 'live-' + results.length, conversationId:'public-formula', action:step.action, turnId:step.turnId, text:step.text, ...(step.regenerate?{regenerate:true}:{}) }, { ...DEFAULT_SETTINGS, apiKey, reasoning: 'low' }, {
      signal: AbortSignal.timeout(90_000), conversation, context:step.context,
      onEvent: event => {
        if (event.type === 'delta') answer += event.text || '';
        if (event.type === 'tool') tools++;
        if (event.type === 'error') failure = event.message;
      }
    });
    results.push({ action:step.action, regenerate:!!step.regenerate, tools, answer, ...(failure ? { error: failure } : {}) });
    if (failure) break;
    if (!firstPrefix) firstPrefix = structuredClone(conversation.messages);
  }
  globalThis.fetch = nativeFetch;
  console.log(JSON.stringify({ keySaved: store.getPublic().hasApiKey, prefixReused, imageCounts, results }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
} finally {
  app.quit();
}
}
void main().catch(error => { console.log(JSON.stringify({ error: error.message })); app.quit(); });
