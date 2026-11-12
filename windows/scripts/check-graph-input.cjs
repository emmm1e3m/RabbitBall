const assert = require('node:assert/strict');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.on('window-all-closed', () => {});

// 使用真实 Chromium 命中和默认输入行为；独立会话不读取桌面配置，也不调用模型。
let window, directory, stage = '初始化';
const temporaryPrefix = path.join(path.resolve(tmpdir()), 'rabbitball-graph-input-');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error(`FAIL ${stage}: 检查超时`); app.exit(1); }, 45000);
function evaluate(fn, ...args) {
  return window.webContents.executeJavaScript(`(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`);
}
async function until(fn, message, ...args) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await evaluate(fn, ...args)) return; await pause(40); }
  throw new Error(message);
}
const command = (name, params) => window.webContents.debugger.sendCommand(name, params);
const mouse = (type, point, held = false) => command('Input.dispatchMouseEvent', {
  type, x: point.x, y: point.y, button: type === 'mouseMoved' && !held ? 'none' : 'left',
  buttons: held || type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1,
});
async function click(point) { await mouse('mousePressed', point); await mouse('mouseReleased', point); }
async function center(selector) {
  return evaluate(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }, selector);
}
async function dragText(selector) {
  const points = await evaluate(selector => {
    const body = document.querySelector(selector), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text; while ((text = walker.nextNode()) && text.textContent.trim().length < 16) {}
    if (!text) throw new Error('缺少可拖选的测试正文');
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1); const start = range.getBoundingClientRect();
    range.setStart(text, 15); range.setEnd(text, 16); const end = range.getBoundingClientRect();
    return { start: { x: start.left + 1, y: start.top + start.height / 2 }, end: { x: end.right - 1, y: end.top + end.height / 2 } };
  }, selector);
  await mouse('mouseMoved', points.start); await mouse('mousePressed', points.start);
  for (let step = 1; step <= 8; step++) await mouse('mouseMoved', {
    x: points.start.x + (points.end.x - points.start.x) * step / 8,
    y: points.start.y + (points.end.y - points.start.y) * step / 8,
  }, true);
  await mouse('mouseReleased', points.end);
}
async function enter(shift = false) {
  // 真实 Enter 含字符事件，按钮的原生键盘激活也依赖这一阶段。
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: shift ? 8 : 0, text: type === 'keyDown' ? '\r' : undefined });
}

async function main() {
  directory = await mkdtemp(temporaryPrefix);
  app.setPath('userData', directory);
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { partition: 'graph-input-check', sandbox: true, backgroundThrottling: false, offscreen: true } });
  await window.loadFile(path.resolve(__dirname, '../prototype/index.html'));
  window.webContents.debugger.attach('1.3');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  assert.equal(await evaluate(() => !!window.rabbitDesktop), false, '必须使用隔离演示桥');
  const ids = await evaluate(async () => {
    const api = window.RabbitGraphDemo;
    let workspace = await api.graphCreate('输入回归');
    workspace = await api.graphMutate(workspace.id, { type: 'create-graph', title: '测试图谱' });
    const graphId = workspace.lastGraphId;
    await api.graphCapture({ workspaceId: workspace.id, graphId });
    workspace = await api.graphOpen(workspace.id);
    const rootId = workspace.graphs[0].rootId;
    workspace = await api.graphMutate(workspace.id, { type: 'add-card', graphId, parentId: rootId,
      title: '普通卡片', markdown: '这是一段用于验证固定卡片正文可以连续拖动选择的测试文字。\n\n第二段保留阅读空间。' });
    await window.RabbitGraph.open({ workspaceId: workspace.id });
    return { workspaceId: workspace.id, graphId, rootId, cardId: workspace.graphs[0].nodes.at(-1).id };
  });
  await pause(600);
  const setPin = (nodeId, pinned) => evaluate(async (ids, nodeId, pinned) => {
    await window.RabbitGraphDemo.graphMutate(ids.workspaceId, { type: 'pin', graphId: ids.graphId, nodeId, pinned });
  }, ids, nodeId, pinned);
  const pinned = (nodeId, expected) => until((id, expected) => window.RabbitGraph.getSnapshot().workspace.graphs[0].nodes.find(node => node.id === id).pinned === expected,
    '固定状态未按单次输入改变', nodeId, expected);

  for (const input of ['鼠标', '触摸']) {
    if (input === '触摸') await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    for (const [name, nodeId] of [['根卡', ids.rootId], ['普通卡', ids.cardId]]) {
      stage = `${input}从卡片外直接固定${name}`;
      await setPin(nodeId, false); await mouse('mouseMoved', { x: 1435, y: 890 }); await pause(220);
      const point = await evaluate(nodeId => {
        const card = document.querySelector(`.rg-world .rg-card[data-node-id="${nodeId}"]`), button = card.querySelector('.rg-pin-toggle');
        const rect = button.getBoundingClientRect(), root = card.classList.contains('is-root');
        const point = { x: rect.left + rect.width * (root ? .75 : .5), y: rect.top + rect.height * (root ? .5 : .2) };
        const hit = document.elementFromPoint(point.x, point.y);
        return { ...point, hit: hit?.closest('.rg-pin-toggle') === button, hovered: card.matches(':hover'), pointerEvents: getComputedStyle(button).pointerEvents };
      }, nodeId);
      assert.equal(point.hovered, false, `${stage}: 检查前不应悬停卡片`);
      assert.equal(point.hit, true, `${stage}: 边缘按钮未命中（pointer-events=${point.pointerEvents}）`);
      if (input === '鼠标') await click(point);
      else {
        await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      await pinned(nodeId, true); await pause(80); await pinned(nodeId, true);
      console.log(`PASS ${stage}`); await setPin(nodeId, false);
    }
  }
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  stage = '固定预览正文拖选';
  await setPin(ids.cardId, true); await evaluate(() => window.RabbitGraph.close()); await pause(500);
  await mouse('mouseMoved', await center('.rg-pin .rg-title')); await pause(500);
  assert.equal(await evaluate(() => document.querySelector('.rg-pin').classList.contains('is-revealed')), true, '悬停未展开固定预览：' + JSON.stringify(await evaluate(() => {
    const title = document.querySelector('.rg-pin .rg-title'), r = title.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { rect: r.toJSON(), hit: hit?.outerHTML.slice(0, 200), holder: title.closest('.rg-pin').outerHTML.slice(0, 200), focused: document.activeElement?.outerHTML.slice(0, 100) };
  })));
  await dragText('.rg-pin .rg-body');
  assert.equal(await evaluate(() => {
    const selection = window.getSelection(); return selection.toString().trim().length >= 10 && document.querySelector('.rg-pin .rg-body').contains(selection.anchorNode);
  }), true, '固定预览正文未产生真实文字选区：' + JSON.stringify(await evaluate(() => ({ text: window.getSelection().toString(), focused: document.hasFocus(), active: document.activeElement?.outerHTML.slice(0, 100), select: getComputedStyle(document.querySelector('.rg-pin .rg-body')).userSelect }))));
  assert.equal(await evaluate(() => window.RabbitGraph.isOpen()), false, '拖选意外打开图谱');
  console.log(`PASS ${stage}（Chromium 输入，不验证 Win32 激活）`);

  stage = '空批注与保存状态';
  await evaluate(async ids => { window.getSelection().removeAllRanges(); await window.RabbitGraph.open({ workspaceId: ids.workspaceId }); }, ids);
  await pause(500);
  const cardPoint = await center(`.rg-world .rg-card[data-node-id="${ids.cardId}"] .rg-body`);
  await mouse('mousePressed', cardPoint);
  await mouse('mouseMoved', { x: cardPoint.x + 3, y: cardPoint.y }, true);
  assert.equal(await evaluate(() => !!document.querySelector('.rg-drag-ghost')), false, '轻微抖动误启动拖动');
  await mouse('mouseMoved', { x: cardPoint.x + 30, y: cardPoint.y + 20 }, true);
  await until(() => !!document.querySelector('.rg-drag-ghost'), '按住卡片无法拖动');
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse('mouseReleased', { x: cardPoint.x + 30, y: cardPoint.y + 20 });
  await until(() => !document.querySelector('.rg-drag-ghost'), '取消拖动后浮动卡片未清理');
  await click(await center(`.rg-world .rg-card[data-node-id="${ids.cardId}"] .rg-body`));
  await until(() => !!document.querySelector('.rg-card-focus') && !document.querySelector('.rg-card-focus').inert, '正文单击未完成展开');
  const controls = await evaluate(() => {
    const card = document.querySelector('.rg-card-focus'), generate = card.querySelector('.rg-generate'), exit = document.querySelector('.rg-plugin .rg-action');
    const a = generate.getBoundingClientRect(), b = exit.getBoundingClientRect(), c = card.getBoundingClientRect();
    return { width: a.width, height: a.height, exitWidth: b.width, exitHeight: b.height, right: a.x + a.width / 2 - c.right, bottom: a.y + a.height / 2 - c.bottom, disabled: generate.disabled, hit: document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2)?.closest('.rg-generate') === generate };
  });
  assert.ok(Math.abs(controls.right + 32) <= 1 && Math.abs(controls.bottom + 32) <= 1, '生成按钮与卡片内边缘未保留10px间距：' + JSON.stringify(controls));
  assert.deepEqual({ ...controls, right: 0, bottom: 0 }, { width: 40, height: 40, exitWidth: 40, exitHeight: 40, right: 0, bottom: 0, disabled: true, hit: true });
  assert.equal(await evaluate(() => {
    const card = document.querySelector('.rg-card-focus'), pin = getComputedStyle(card.querySelector('.rg-pin-toggle')), remove = getComputedStyle(card.querySelector('[aria-label="删除卡片及其子卡片"]'));
    return ['width', 'height', 'borderRadius', 'borderWidth', 'boxShadow'].every(key => pin[key] === remove[key]) && !document.querySelector('.rg-handle');
  }), true, '删除与固定按钮样式不一致，或拖动手柄仍存在');
  await dragText('.rg-card-focus .rg-body');
  await until(() => !!document.querySelector('.rg-note-editor'), '拖选正文未打开批注');
  assert.equal(await evaluate(() => document.querySelector('.rg-confirm').disabled), true, '空批注保存按钮未禁用');
  await enter(); await click(await center('.rg-confirm')); await pause(100);
  assert.equal(await evaluate(id => window.RabbitGraph.getSnapshot().workspace.graphs[0].nodes.find(node => node.id === id).annotations.length, ids.cardId), 0, '空批注被写入');
  assert.equal(await evaluate(() => !!document.querySelector('.rg-note-editor')), true, '空提交意外关闭批注编辑器');
  // 禁用按钮的点击不保证保留输入框焦点，重新通过真实点击输入。
  await click(await center('.rg-note-editor textarea'));
  await command('Input.insertText', { text: '　  ' });
  assert.equal(await evaluate(() => document.querySelector('.rg-confirm').disabled), true, '空白批注启用了保存');
  await command('Input.insertText', { text: '验证批注' });
  assert.equal(await evaluate(() => document.querySelector('.rg-confirm').disabled), false, '有效批注仍不能保存');
  await enter(true);
  await command('Input.insertText', { text: '第二行' });
  assert.equal(await evaluate(() => document.querySelector('.rg-note-editor textarea').value.trim()), '验证批注\n第二行', 'Shift+Enter 没有输入换行');
  await enter();
  await until(id => window.RabbitGraph.getSnapshot().workspace.graphs[0].nodes.find(node => node.id === id).annotations.some(note => note.comment === '验证批注\n第二行'), '有效批注未保存', ids.cardId);
  await until(() => document.activeElement === document.querySelector('.rg-generate'), '保存后未将焦点交给生成按钮');
  assert.equal(await evaluate(id => window.RabbitGraph.getSnapshot().workspace.graphs[0].nodes.find(node => node.id === id).annotations.some(note => note.childId), ids.cardId), false, '第一次Enter不应生成子节点');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', autoRepeat: true });
  assert.equal(await evaluate(() => !!document.querySelector('.rg-focus .rg-card')), true, '长按Enter不应越过确认步骤');
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await enter();
  await until(id => window.RabbitGraph.getSnapshot().workspace.graphs[0].nodes.find(node => node.id === id).annotations.some(note => note.childId), '第二次回车没有生成子节点', ids.cardId);
  assert.equal(await evaluate(() => !!document.querySelector('.rg-focus .rg-card')), false, '生成子节点前未收起展开卡片');
  assert.equal(await evaluate(id => {
    const graph = window.RabbitGraph.getSnapshot().workspace.graphs[0], child = graph.nodes.find(node => node.parentId === id);
    const card = document.querySelector(`.rg-world .rg-card[data-node-id="${child.id}"]`), edge = document.querySelector(`.rg-edges path[data-node-id="${child.id}"]`);
    return card.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.transform?.includes('translateX'))) && edge.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.strokeDashoffset === '1'));
  }, ids.cardId), true, '新卡片或连线缺少分支入场动画');
  console.log(`PASS ${stage}`);
  stage = '根节点截图优先与追加内容';
  await evaluate(() => {
    const image = window.RabbitGraph.getSnapshot().workspace.graphs.flatMap(graph => graph.nodes).flatMap(node => node.images)[0];
    window.RabbitCapture = { ...window.RabbitCapture, captureImages: async () => [{ ...image, id: crypto.randomUUID(), title: '新增资料' }] };
  });
  await click(await center('.rg-add-graph'));
  await until(() => !!document.querySelector('[aria-label="添加根节点"]'), '新图谱缺少添加根节点入口');
  await click(await center('[aria-label="添加根节点"]'));
  await until(() => !!document.querySelector('.rg-card-focus') && !document.querySelector('.rg-card-focus').inert, '首张截图后没有展开根卡片');
  assert.equal(await evaluate(() => !!document.querySelector('.rg-root-editor,.rg-dialog')), false, '创建根节点仍出现前置输入框');
  assert.equal(await evaluate(() => document.querySelectorAll('.rg-card-focus .rg-image').length), 1, '首张截图未创建根节点');
  await click(await center('.rg-card-focus [aria-label="添加截图"]'));
  await until(() => document.querySelectorAll('.rg-card-focus .rg-image').length === 2, '根节点未追加第二张截图');
  await click(await center('.rg-card-focus [aria-label="添加文本"]'));
  await until(() => !!document.querySelector('.rg-root-text textarea'), '未打开卡片内文字编辑');
  await command('Input.insertText', { text: '两张截图的共同背景\n请结合这些资料理解问题。' });
  await enter();
  await until(() => !document.querySelector('.rg-root-text'), '保存根节点文本后编辑区未收起');
  assert.equal(await evaluate(() => {
    const snapshot = window.RabbitGraph.getSnapshot(), graph = snapshot.workspace.graphs.find(graph => graph.id === snapshot.graphId), root = graph.nodes.find(node => node.id === graph.rootId);
    return graph.nodes.length === 1 && root.images.length === 2 && root.markdown === '两张截图的共同背景\n请结合这些资料理解问题。';
  }), true, '根节点没有同时保留多图和文本');
  console.log(`PASS ${stage}`);
  stage = '自定义卡片直接创建与图文批注';
  await evaluate(() => {
    const captureImages=window.RabbitCapture.captureImages;
    window.__customCaptureCount=0;
    window.RabbitCapture={...window.RabbitCapture,captureImages:async()=>{window.__customCaptureCount++;return captureImages();}};
  });
  const parentId=await evaluate(()=>document.querySelector('.rg-card-focus').dataset.nodeId);
  await click(await center('.rg-card-focus [aria-label="添加自定义卡片"]'));
  await until(parentId=>{
    const focus=document.querySelector('.rg-card-focus');return focus&&focus.dataset.nodeId!==parentId&&!focus.inert;
  },'自定义卡片未直接创建并展开',parentId);
  const customId=await evaluate(()=>document.querySelector('.rg-card-focus').dataset.nodeId);
  assert.equal(await evaluate(()=>window.__customCaptureCount),0,'自定义卡片不应要求先截图');
  assert.equal(await evaluate(()=>!!document.querySelector('.rg-card-focus [aria-label="重新生成"]')),false,'用户资料不应提供重新生成');
  await click(await center('.rg-card-focus [aria-label="添加文本"]'));
  await command('Input.insertText',{text:'这是一张直接输入文本建立的自定义资料卡片，可以选中这段内容进行批注。'});
  await enter();
  await until(()=>!document.querySelector('.rg-root-text'),'自定义文本未保存');
  assert.equal(await evaluate((customId,parentId)=>{
    const current=window.RabbitGraph.getSnapshot(),node=current.workspace.graphs.find(graph=>graph.id===current.graphId).nodes.find(node=>node.id===customId);
    return node.parentId===parentId&&node.kind==='source'&&node.images.length===0&&node.markdown.includes('直接输入文本');
  },customId,parentId),true,'纯文本卡片未连接到原节点');
  await click(await center('.rg-card-focus [aria-label="添加截图"]'));
  await until(()=>document.querySelectorAll('.rg-card-focus .rg-image').length===1,'自定义卡片未追加截图');
  await evaluate(()=>{document.querySelector('.rg-card-focus .rg-body').scrollIntoView({block:'center'});});
  await dragText('.rg-card-focus .rg-body');
  await until(()=>!!document.querySelector('.rg-note-editor'),'自定义文本不能批注');
  await command('Input.insertText',{text:'基于这份自定义资料生成解释。'});
  await enter();
  await until(()=>document.activeElement===document.querySelector('.rg-generate'),'自定义批注首次回车未仅完成编写');
  await enter();
  await until(customId=>{
    const current=window.RabbitGraph.getSnapshot();return current.workspace.graphs.find(graph=>graph.id===current.graphId).nodes.some(node=>node.parentId===customId&&node.kind==='card');
  },'自定义卡片的批注未生成子节点',customId);
  console.log(`PASS ${stage}`);
  stage = '普通卡片常显加号与直接创建';
  await pause(500);await mouse('mouseMoved',{x:1435,y:890});
  assert.equal(await evaluate(customId=>{
    const card=document.querySelector(`.rg-world .rg-card[data-node-id="${customId}"]`),tools=card.querySelector('.rg-card-tools');
    return getComputedStyle(tools).opacity==='1'&&!!tools.querySelector('[aria-label="添加自定义卡片"]');
  },customId),true,'未悬停时普通卡片加号未常显');
  await click(await center(`.rg-world .rg-card[data-node-id="${customId}"] [aria-label="添加自定义卡片"]`));
  await until(customId=>{
    const focus=document.querySelector('.rg-card-focus');if(!focus||focus.inert)return false;
    const current=window.RabbitGraph.getSnapshot(),node=current.workspace.graphs.find(graph=>graph.id===current.graphId).nodes.find(node=>node.id===focus.dataset.nodeId);
    return node.parentId===customId&&node.kind==='source'&&!node.markdown&&!node.images.length;
  },'普通卡片加号未创建并展开空白自定义子卡',customId);
  console.log(`PASS ${stage}`);
  if (process.env.RABBITBALL_GRAPH_SCREENSHOT) {
    await pause(400);
    const target = path.resolve(process.env.RABBITBALL_GRAPH_SCREENSHOT);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, (await window.webContents.capturePage()).toPNG());
  }
}

main().then(() => finish(0), error => { console.error(`FAIL ${stage}: ${error.stack || error}`); return finish(1); });
async function finish(code) {
  clearTimeout(watchdog);
  if (window && !window.isDestroyed()) window.destroy();
  // Electron 退出时释放会话文件；先核对路径，再清理本次创建的临时目录。
  if (directory) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.dirname(temporaryPrefix) || !target.startsWith(temporaryPrefix)) {
      console.error('FAIL 临时目录超出本次检查范围，已停止清理'); code = 1;
    } else {
      await rm(target, { recursive: true, force: true, maxRetries: 3 })
        .catch(error => console.warn(`WARN 临时目录未完全清理：${target}（${error.message}）`));
    }
  }
  app.exit(code);
}
