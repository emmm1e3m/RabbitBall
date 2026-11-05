import { app, BrowserWindow } from 'electron';
import path from 'node:path';
app.setPath('userData',path.join(app.getPath('temp'),'rabbitball-public-fixture'));
async function main() {
await app.whenReady();
const window = new BrowserWindow({width:720,height:480,autoHideMenuBar:true,title:'RabbitBall 公共测试窗口',webPreferences:{sandbox:true,nodeIntegration:false}});
window.setMenu(null);
await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><title>RabbitBall 公共测试窗口</title><body style="background:#fff;color:#25252b;font:18px Segoe UI;padding:36px"><label for="public-input" style="font-size:14px">公开输入框焦点测试</label><input id="public-input" aria-label="公开测试输入框" autofocus value="等待切换焦点" style="display:block;box-sizing:border-box;width:100%;height:36px;margin-top:8px;padding:6px 10px;border:1px solid #ddd;border-radius:8px;font:16px Segoe UI"><p style="margin-top:28px">Newton’s second law</p><p style="font:44px Georgia;margin:24px 0">F = ma</p><p>Force = mass × acceleration</p></body>'));
window.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.key==='F11'){event.preventDefault();window.setFullScreen(!window.isFullScreen());}});
window.on('closed',()=>app.quit());
}
void main();
