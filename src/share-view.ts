export const shareView = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser Bridge · Live tab</title>
<style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#000;color:#eceee7}*{box-sizing:border-box}body{margin:0;height:100dvh;overflow:hidden}main{width:100%;height:100%;padding:0;display:flex;align-items:center;justify-content:center;overflow:hidden}canvas{display:block;touch-action:none;max-width:100%;max-height:100%;object-fit:contain}#empty{position:absolute;display:flex;align-items:center;gap:16px;padding:16px;background:#141716}#status{font-size:12px}button{background:#252d25;color:#ddebcc;border:1px solid #53624a;padding:8px 12px;cursor:pointer;font:inherit;font-size:12px}button:disabled{opacity:.4;cursor:default}#keyboard{position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;padding:0;border:0;resize:none}[hidden]{display:none!important}
body{display:flex}main{flex:1;min-width:0;min-height:0;position:relative}
#tabs{--side-width:244px;position:relative;width:var(--side-width);flex:none;background:#0a0a0a;color:#ededed;border-right:1px solid #262626;display:flex;flex-direction:column;padding:16px 10px 10px;gap:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#tab-heading{display:flex;align-items:center;justify-content:space-between;padding:0 6px;gap:8px}#tab-label{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}#tab-count{font-size:11px;font-weight:400;color:#888;background:#1a1a1a;padding:2px 6px;border-radius:4px}.tab-tools{display:flex;gap:2px}#tabs .tool{display:grid;place-items:center;background:transparent;border:0;border-radius:4px;width:28px;height:28px;padding:5px;color:#888}#tabs .tool:hover{background:#1f1f1f;color:#ededed}#tabs svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.5}
#tab-search{width:100%;min-width:0;border:1px solid #333;background:#111;color:#ededed;border-radius:4px;padding:8px 10px;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none}#tab-search:focus{border-color:#888}#tab-search::placeholder{color:#777}
#tab-list{display:flex;flex-direction:column;gap:3px;overflow:auto;min-height:0;scrollbar-width:thin;scrollbar-color:#333 transparent}.tab{position:relative;display:flex;align-items:center;gap:10px;min-height:44px;width:100%;text-align:left;border:0;border-radius:5px;background:transparent;padding:6px 10px;color:#a1a1a1;font-family:inherit}.tab:hover{background:#171717}.tab[aria-selected=true]{background:#1f1f1f;color:#fff}.tab[aria-selected=true]:before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;background:#ededed}.tab-icon{flex:none;display:grid;place-items:center;width:26px;height:26px;background:#171717;border:1px solid #333;border-radius:5px;font-size:11px;font-weight:600;color:#666}.tab[aria-selected=true] .tab-icon{color:#ededed;border-color:#555}.tab-copy{min-width:0;flex:1}.tab-title,.tab small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tab-title{font-size:12px;line-height:17px;font-weight:500}.tab small{font-size:10px;color:#727272;line-height:15px;margin-top:1px}.tab[aria-selected=true] small{color:#888}.tab:focus-visible,#tabs .tool:focus-visible{outline:2px solid #888;outline-offset:-2px}
#tab-empty{font-size:12px;color:#777;text-align:center;padding:20px 0}#tab-resize{position:absolute;right:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:2}#tab-resize:hover{background:#ededed44}body.tabs-collapsed #tabs{width:58px;padding:12px 6px}body.tabs-collapsed #tab-label,body.tabs-collapsed #layout,body.tabs-collapsed #tab-search,body.tabs-collapsed .tab-copy,body.tabs-collapsed #tab-resize{display:none}body.tabs-collapsed #tab-heading{justify-content:center;padding:0}body.tabs-collapsed .tab{justify-content:center;padding:8px 4px;min-height:44px}
body.tabs-top{flex-direction:column}body.tabs-top #tabs{width:100%;padding:8px 12px;flex-direction:row;align-items:center;border-right:0;border-bottom:1px solid #262626;gap:12px}body.tabs-top #tab-heading{flex:none}body.tabs-top #tab-search{width:130px;flex:none}body.tabs-top #tab-list{flex-direction:row;overflow:auto}body.tabs-top .tab{width:180px;flex:none;min-height:44px}body.tabs-top .tab[aria-selected=true]:before{left:8px;right:8px;bottom:0;top:auto;height:3px;width:auto}body.tabs-top #tab-resize,body.tabs-top #collapse{display:none}body.tabs-top main{height:0}@media(max-width:600px){#tabs{width:180px}body.tabs-top #tab-label,body.tabs-top #tab-search{display:none}}
</style>
<aside id="tabs" hidden aria-label="浏览器标签页"><div id="tab-heading"><div id="tab-label">标签页 <span id="tab-count">0</span></div><div class="tab-tools"><button class="tool" id="layout" title="置于顶部" aria-label="置于顶部"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2"/><path d="M3 7h14M7 3v4"/></svg></button><button class="tool" id="collapse" title="收起标签栏" aria-label="收起标签栏"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 5l-5 5 5 5"/></svg></button></div></div><input id="tab-search" type="search" placeholder="搜索标签页" aria-label="搜索标签页"><div id="tab-list" role="tablist" aria-orientation="vertical"></div><div id="tab-empty" hidden>没有匹配的标签页</div><div id="tab-resize" role="separator" aria-label="调整标签栏宽度" aria-orientation="vertical"></div></aside><main><div id="empty"><span id="status" role="status">等待连接</span><button id="connect">连接</button></div><canvas hidden aria-label="远程标签页；支持点击、拖动和滚动"></canvas><textarea id="keyboard" aria-label="输入到远程标签页" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></main>
<script>
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),status=document.querySelector('#status'),button=document.querySelector('#connect'),empty=document.querySelector('#empty'),keyboard=document.querySelector('#keyboard');
const tabPanel=document.querySelector('#tabs'),tabList=document.querySelector('#tab-list'),layout=document.querySelector('#layout'),collapse=document.querySelector('#collapse'),search=document.querySelector('#tab-search');
function setLayout(top){document.body.classList.toggle('tabs-top',top);document.body.classList.remove('tabs-collapsed');const label=top?'置于左侧':'置于顶部';layout.title=label;layout.setAttribute('aria-label',label);tabList.setAttribute('aria-orientation',top?'horizontal':'vertical')}
try{setLayout(sessionStorage.getItem('tab-layout')==='top');const width=Number(sessionStorage.getItem('tab-width'));if(width>=180&&width<=360)tabPanel.style.setProperty('--side-width',width+'px')}catch{}
layout.onclick=()=>{const top=!document.body.classList.contains('tabs-top');setLayout(top);try{sessionStorage.setItem('tab-layout',top?'top':'left')}catch{}};
collapse.onclick=()=>{const collapsed=document.body.classList.toggle('tabs-collapsed');collapse.title=collapsed?'展开标签栏':'收起标签栏';collapse.setAttribute('aria-label',collapse.title);collapse.style.transform=collapsed?'rotate(180deg)':''};
const resize=document.querySelector('#tab-resize');resize.onpointerdown=e=>{e.preventDefault();resize.setPointerCapture(e.pointerId)};resize.onpointermove=e=>{if(!resize.hasPointerCapture(e.pointerId))return;const width=Math.max(180,Math.min(360,e.clientX));tabPanel.style.setProperty('--side-width',width+'px');try{sessionStorage.setItem('tab-width',String(width))}catch{}};
function filterTabs(){const query=search.value.toLocaleLowerCase();let visible=0;for(const el of tabList.children){el.hidden=!el.title.toLocaleLowerCase().includes(query);if(!el.hidden)visible++}document.querySelector('#tab-empty').hidden=visible>0}
search.oninput=filterTabs;
function showTabs(m){
  tabPanel.hidden=false;document.querySelector('#tab-count').textContent=m.tabs.length;
  const existing=new Map([...tabList.children].map(el=>[Number(el.dataset.id),el]));
  let index=0;
  for(const t of m.tabs){
    let el=existing.get(t.id);existing.delete(t.id);
    if(!el){
      el=document.createElement('button');el.className='tab';el.dataset.id=t.id;el.setAttribute('role','tab');
      el.innerHTML='<span class="tab-icon" aria-hidden="true"></span><span class="tab-copy"><span class="tab-title"></span><small></small></span>';
      el.onclick=()=>{if(ws?.readyState!==1)return;release();releaseKeys();renderEpoch++;frame=null;canvas.hidden=true;empty.hidden=false;status.textContent='正在切换标签页';button.hidden=true;ws.send(JSON.stringify({type:'select-tab',tabId:t.id}))};
    }
    let host=t.url;try{host=new URL(t.url).hostname||t.url}catch{}
    el.querySelector('.tab-title').textContent=t.title;el.querySelector('small').textContent=host;
    el.querySelector('.tab-icon').textContent=(host||t.title).slice(0,1).toUpperCase();el.title=t.title+' · '+t.url;
    el.setAttribute('aria-selected',String(t.id===m.selectedId));
    if(tabList.children[index]!==el)tabList.insertBefore(el,tabList.children[index]||null);index++;
  }
  for(const el of existing.values())el.remove();filterTabs();
}
let renderEpoch=0;
let ws,frame=null,pointer=null;
function fit(){if(!frame)return;const area=canvas.parentElement;const style=getComputedStyle(area);const width=area.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),height=area.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);const scale=Math.min(width/canvas.width,height/canvas.height);canvas.style.width=canvas.width*scale+'px';canvas.style.height=canvas.height*scale+'px'}
new ResizeObserver(fit).observe(canvas.parentElement);
function point(e){const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}}
function send(input){if(ws?.readyState===1&&frame)ws.send(JSON.stringify({type:'input',geometry:frame.geometry,...input}))}
let decoder=null,videoGeometry='',videoFrames=new Map();
function resetVideo(){if(decoder&&decoder.state!=='closed')decoder.close();decoder=null;videoGeometry='';videoFrames.clear()}
function streamError(message){resetVideo();renderEpoch++;frame=null;canvas.hidden=true;empty.hidden=false;status.textContent=message;button.hidden=false;button.disabled=false;if(ws){ws.onclose=null;ws.close()}}
function decodeVideo(packet){
  try{
    const size=new DataView(packet).getUint32(0);if(size>packet.byteLength-4)throw Error('Invalid packet');
    const m=JSON.parse(new TextDecoder().decode(new Uint8Array(packet,4,size))),v=m.video;
    if(!decoder||videoGeometry!==m.geometry){
      resetVideo();if(v.type!=='key')throw Error('Missing keyframe');videoGeometry=m.geometry;
      const epoch=renderEpoch;
      decoder=new VideoDecoder({output(image){try{const meta=videoFrames.get(image.timestamp);videoFrames.delete(image.timestamp);if(!meta||epoch!==renderEpoch)return;canvas.width=image.displayWidth;canvas.height=image.displayHeight;ctx.drawImage(image,0,0);frame=meta;canvas.hidden=false;empty.hidden=true;button.hidden=false;status.textContent='● 已连接 · VP8';canvas.dataset.transport='vp8';fit()}finally{image.close()}},error:error=>streamError('串流解码失败：'+error.message)});
      decoder.configure({codec:v.codec,codedWidth:v.width,codedHeight:v.height,optimizeForLatency:true});
    }
    if(decoder.decodeQueueSize>30)throw Error('Decoder overloaded');
    videoFrames.set(v.timestamp,m);decoder.decode(new EncodedVideoChunk({type:v.type,timestamp:v.timestamp,data:new Uint8Array(packet,4+size)}));
  }catch(error){streamError('串流解码失败：'+error.message)}
}
async function connect(){
  button.disabled=true;status.textContent='连接中';let video=false;
  try{video=typeof VideoDecoder!=='undefined'&&(await VideoDecoder.isConfigSupported({codec:'vp8'})).supported}catch{}
  if(!video){status.textContent='此浏览器不支持 WebCodecs VP8，请使用 localhost 或 HTTPS';button.disabled=false;return}
  ws=new WebSocket(location.protocol.replace('http','ws')+'//'+location.host+location.pathname+'stream');ws.binaryType='arraybuffer';
  ws.onopen=()=>ws.send(JSON.stringify({type:'hello',video}));
  ws.onmessage=e=>{
    if(e.data instanceof ArrayBuffer){decodeVideo(e.data);return}
    const m=JSON.parse(e.data);
    if(m.type==='tabs')showTabs(m);
    if(m.type==='paused'){resetVideo();renderEpoch++;frame=null;pointer=null;canvas.hidden=true;empty.hidden=false;status.textContent=m.message;button.hidden=true}
    if(m.type==='error'){if(m.fatal)streamError(m.error);else status.textContent=m.error}
  };
  ws.onclose=()=>{resetVideo();renderEpoch++;frame=null;pointer=null;empty.hidden=false;status.textContent='连接已关闭 · 可重新连接';button.hidden=false;button.disabled=false;button.textContent='重新连接'};
  ws.onerror=()=>status.textContent='连接失败';
}
button.onclick=connect;
canvas.oncontextmenu=e=>e.preventDefault();
canvas.onpointerdown=e=>{if(e.button!==0||!frame)return;e.preventDefault();keyboard.style.left=e.clientX+'px';keyboard.style.top=e.clientY+'px';keyboard.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);pointer={id:e.pointerId,type:e.pointerType,x:e.clientX,y:e.clientY,moved:false,origin:point(e)};if(e.pointerType!=='touch')send({event:'down',...point(e)})};
canvas.onpointermove=e=>{if(!pointer||pointer.id!==e.pointerId)return;const p=point(e);if(pointer.type==='touch'){const dx=pointer.x-e.clientX,dy=pointer.y-e.clientY;if(Math.abs(dx)+Math.abs(dy)>2){pointer.moved=true;send({event:'wheel',...p,deltaX:dx,deltaY:dy});pointer.x=e.clientX;pointer.y=e.clientY}return}send({event:'move',...p})};
canvas.onpointerup=e=>{if(!pointer||pointer.id!==e.pointerId)return;if(pointer.type==='touch'){if(!pointer.moved){send({event:'down',...pointer.origin});send({event:'up',...pointer.origin})}}else send({event:'up',...point(e)});pointer=null};
function release(){if(pointer&&pointer.type!=='touch')send({event:'up',...pointer.origin});pointer=null}
canvas.onpointercancel=release;canvas.onlostpointercapture=release;window.addEventListener('blur',release);document.addEventListener('visibilitychange',()=>{if(document.hidden)release()});
canvas.addEventListener('wheel',e=>{e.preventDefault();const factor=e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1;send({event:'wheel',...point(e),deltaX:Math.max(-2000,Math.min(2000,e.deltaX*factor)),deltaY:Math.max(-2000,Math.min(2000,e.deltaY*factor))})},{passive:false});
let composing=false;
const keys=new Set();
function textInput(){if(composing)return;const text=keyboard.value;keyboard.value='';for(let i=0;i<text.length;i+=4096)send({event:'text',text:text.slice(i,i+4096)})}
keyboard.addEventListener('compositionstart',()=>{composing=true});
keyboard.addEventListener('compositionend',()=>{composing=false;textInput()});
keyboard.addEventListener('input',e=>{if(!e.isComposing)textInput()});
function keyEvent(e,phase){send({event:'key',phase,key:e.key,code:e.code,keyCode:e.keyCode,modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0)})}
keyboard.addEventListener('keydown',e=>{
  if(e.isComposing||composing||e.keyCode===229||['Shift','Control','Alt','Meta','Dead','Process','Unidentified'].includes(e.key))return;
  if((e.ctrlKey||e.metaKey)&&['v','c','x'].includes(e.key.toLowerCase()))return;
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey)return;
  e.preventDefault();keys.add(e.code);keyEvent(e,'down');
});
keyboard.addEventListener('keyup',e=>{if(!keys.delete(e.code))return;e.preventDefault();keyEvent(e,'up')});
function releaseKeys(){keys.clear();send({event:'release'})}
keyboard.addEventListener('blur',releaseKeys);
window.addEventListener('blur',releaseKeys);
document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseKeys()});
connect();
</script></html>`;
