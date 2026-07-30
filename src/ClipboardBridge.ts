/**
 * VS Code delivers copy/cut/paste/selectAll to webviews via execCommand on the #active-frame
 * document, which never reaches a nested cross-origin iframe. Linux and Windows still fall
 * back to native handling, but macOS routes these through the system menu that VS Code
 * disables while a webview has focus. The copy buttons fail on every platform because the
 * Clipboard API is unavailable in this frame. Both paths go through the extension host
 * instead of widening the iframe Permissions Policy. See microsoft/vscode#129178.
 */
export const WEBSIDEBAR_CLIPBOARD_SCRIPT = `<script>
(function(){
  if(window.__ocWebSidebarClipboard)return;
  window.__ocWebSidebarClipboard=true;

  var REQUEST_TIMEOUT_MS=1000;
  var pending={};
  var seq=0;

  function request(type,payload){
    return new Promise(function(resolve,reject){
      var id=++seq;
      var timer=setTimeout(function(){
        if(pending[id]){delete pending[id];reject(new Error('ocClipboard request timed out'))}
      },REQUEST_TIMEOUT_MS);
      pending[id]=function(msg){clearTimeout(timer);resolve(msg)};
      var body={type:type,id:id};
      for(var key in payload)body[key]=payload[key];
      window.parent.postMessage(body,'*');
    });
  }

  window.addEventListener('message',function(event){
    if(event.source!==window.parent)return;
    var msg=event.data;
    if(!msg||msg.type!=='ocClipboardResponse')return;
    var resolver=pending[msg.id];
    if(!resolver)return;
    delete pending[msg.id];
    resolver(msg);
  });

  function readClipboardText(){
    return request('ocClipboardReadRequest',{}).then(function(msg){
      return typeof msg.text==='string'?msg.text:'';
    });
  }

  function writeClipboardText(text){
    return request('ocClipboardWriteRequest',{text:text==null?'':String(text)}).then(function(msg){
      if(!msg.ok)throw new Error('clipboard write failed');
    });
  }

  // The copy buttons call navigator.clipboard.writeText, which this nested iframe cannot use.
  // Routing through the extension host avoids granting clipboard-write via Permissions Policy.
  var nativeClipboard=window.navigator.clipboard;
  try{
    Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{
      writeText:writeClipboardText,
      readText:readClipboardText,
      // Images and other formats stay on the native path.
      write:function(items){
        return nativeClipboard&&nativeClipboard.write
          ? nativeClipboard.write.call(nativeClipboard,items)
          : Promise.reject(new Error('clipboard.write unavailable'));
      },
      read:function(){
        return nativeClipboard&&nativeClipboard.read
          ? nativeClipboard.read.call(nativeClipboard)
          : Promise.reject(new Error('clipboard.read unavailable'));
      }
    }});
  }catch(e){}

  function withNativeFallback(type,fallback){
    var fired=false;
    function mark(){fired=true}
    document.addEventListener(type,mark,true);
    setTimeout(function(){
      document.removeEventListener(type,mark,true);
      if(!fired)fallback();
    },0);
  }

  var SHORTCUTS={
    a:function(){document.execCommand('selectAll')},
    c:function(){withNativeFallback('copy',function(){document.execCommand('copy')})},
    x:function(){withNativeFallback('cut',function(){document.execCommand('cut')})},
    v:function(){withNativeFallback('paste',function(){
      readClipboardText().then(function(text){
        if(text)document.execCommand('insertText',false,text);
      }).catch(function(){});
    })}
  };

  document.addEventListener('keydown',function(event){
    if(!event.isTrusted||event.defaultPrevented)return;
    if(!(event.metaKey||event.ctrlKey)||event.altKey||event.shiftKey)return;
    var handler=SHORTCUTS[(event.key||'').toLowerCase()];
    if(handler)handler();
  },true);
})();
</script>`;
