(() => {
  'use strict';
  // 对话附件和工作区背景共用入口，文档解析始终交给桌面解析进程。
  async function readFile(file, options = {}) {
    if (!file || !file.name) throw new Error('解析失败：未能读取文件。');
    const id = 'attachment-' + crypto.randomUUID();
    if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      if (file.size > 5 * 1024 * 1024) throw new Error('解析失败：图片不能超过 5 MiB。');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('解析失败：未能读取图片，请重新选择。'));
        reader.readAsDataURL(file);
      });
      return { id, name: file.name, mimeType: file.type, format: file.type.split('/')[1], dataUrl };
    }
    if (file.size > 50 * 1024 * 1024) throw new Error('解析失败：文件不能超过 50 MiB。');
    if (!window.rabbitDesktop?.parseDocument) throw new Error('请在桌面版兔球中导入文档。');
    const result = await window.rabbitDesktop.parseDocument({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}) });
    return { ...result, id };
  }

  const style = document.createElement('style');
  style.textContent = `
    .rabbit-attachment-tile { position:relative;box-sizing:border-box;display:grid;grid-template-rows:minmax(0,1fr) 30px;flex:0 0 auto;width:144px;height:112px;overflow:hidden;border:1px solid var(--rb-line,#eadfe5);border-radius:15px;background:#fff;color:var(--rb-text,#624a58);transition:border-color .18s,box-shadow .18s; }
    .rabbit-attachment-tile:hover { border-color:var(--rb-accent,#df89a8);box-shadow:0 3px 12px #9e6c8210; }
    .rabbit-attachment-preview { position:relative;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0;margin:5px 5px 0;border-radius:10px;background:var(--rb-soft,#fcf7fa);overflow:hidden; }
    .rabbit-attachment-preview>img { display:block;width:100%;height:100%;object-fit:contain; }
    .rabbit-attachment-preview>svg { width:30px;height:35px;fill:none;stroke:var(--rb-text-muted,#aa929e);stroke-width:1.5px;stroke-linecap:round;stroke-linejoin:round; }
    .rabbit-attachment-format { position:absolute;left:8px;bottom:6px;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;padding:2px 5px;border-radius:4px;background:#ffffffed;color:var(--rb-accent,#d37798);font-size:9px;font-weight:600;line-height:1.3;letter-spacing:.04em; }
    .rabbit-attachment-meta { display:flex;align-items:center;gap:5px;min-width:0;padding:3px 9px 5px; }
    .rabbit-attachment-kind { flex:none;display:flex;align-items:center;color:var(--rb-accent,#d37798); }
    .rabbit-attachment-kind>svg { width:13px;height:15px;fill:none;stroke:currentColor;stroke-width:1.5px;stroke-linecap:round;stroke-linejoin:round; }
    .rabbit-attachment-name { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:1.4;color:inherit; }
    .rabbit-attachment-tile .rabbit-attachment-remove { position:absolute;z-index:2;right:7px;top:7px;display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid #eadfe5;border-radius:50%;background:#fffffff5;color:#9f8391;cursor:pointer;box-shadow:0 1px 5px #7b4a6410; }
    .rabbit-attachment-tile .rabbit-attachment-remove:hover { color:var(--rb-accent,#d37798);background:#fff4f8;border-color:#edb9cd; }
    .rabbit-attachment-tile .rabbit-attachment-remove>svg { width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:1.5px;stroke-linecap:round; }
    .rabbit-attachment-preview>svg>*,.rabbit-attachment-kind>svg>*,.rabbit-attachment-remove>svg>* { vector-effect:non-scaling-stroke; }
    .rabbit-attachment-tile .rabbit-attachment-remove:disabled { opacity:.4;cursor:default; }
    .rabbit-attachment-remove:focus-visible { outline:2px solid var(--rb-accent,#d37798);outline-offset:2px; }
  `;
  document.head.appendChild(style);
  const fileIcon = '<svg viewBox="0 0 28 34" aria-hidden="true"><path d="M17 2H6a3 3 0 0 0-3 3v24a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V10Z"/><path d="M17 2v7a2 2 0 0 0 2 2h6"/></svg>';
  const imageIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="3"/><circle cx="7" cy="7" r="1.5"/><path d="m3 15 4-4 3 3 3-5 4 6"/></svg>';

  // 三个上传入口使用同一份附件预览，文字内容只由解析与上下文层读取。
  function createTile(attachment, options = {}) {
    const tile = document.createElement('div');tile.className='rabbit-attachment-tile';
    tile.setAttribute('role','group');tile.setAttribute('aria-label','附件：'+attachment.name);
    const preview=document.createElement('div');preview.className='rabbit-attachment-preview';
    const isImage=attachment.mimeType?.startsWith('image/')&&attachment.dataUrl;
    if(isImage){const image=document.createElement('img');image.src=attachment.dataUrl;image.alt=attachment.name;preview.appendChild(image);}
    else {
      preview.innerHTML=fileIcon;
      const format=document.createElement('span');format.className='rabbit-attachment-format';
      const label=attachment.format||attachment.name.split('.').slice(1).at(-1)||'TEXT';
      format.textContent=label.toUpperCase().slice(0,10);format.title=label;preview.appendChild(format);
    }
    const meta=document.createElement('div');meta.className='rabbit-attachment-meta';
    const kind=document.createElement('span');kind.className='rabbit-attachment-kind';kind.innerHTML=isImage?imageIcon:fileIcon;
    const name=document.createElement('span');name.className='rabbit-attachment-name';name.textContent=attachment.name;name.title=attachment.name;
    meta.append(kind,name);tile.append(preview,meta);
    if(options.onRemove){const remove=document.createElement('button');remove.type='button';remove.className='rabbit-attachment-remove';remove.disabled=!!options.removeDisabled;remove.setAttribute('aria-label','移除附件：'+attachment.name);remove.title='移除附件';remove.innerHTML='<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3l-6 6"/></svg>';remove.addEventListener('click',event=>{event.stopPropagation();if(!remove.disabled)options.onRemove();});tile.appendChild(remove);}
    return tile;
  }
  window.RabbitDocuments = Object.freeze({ readFile, createTile });
})();
