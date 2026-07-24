export const OPENCODE_SERVER_STATE_KEY = 'opencode.global.dat:server';

/**
 * Runs before the OpenCode app bundle. The new web UI only considers projects
 * recorded in its persisted server state when it creates a draft. Registering
 * the directory from the legacy /:dir/session route restores the old behavior
 * for workspaces that have never been opened in OpenCode before.
 */
export const OPENCODE_PROJECT_BOOTSTRAP_SCRIPT = `<script>
(function(){
  if(window.__ocWebSidebarProjectBootstrap)return;
  window.__ocWebSidebarProjectBootstrap=true;

  function decodeRouteSegment(value){
    try{
      var base64=value.replace(/-/g,'+').replace(/_/g,'/');
      while(base64.length%4)base64+='=';
      var binary=atob(base64);
      var bytes=new Uint8Array(binary.length);
      for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }catch(e){
      return '';
    }
  }

  function pathKey(value){
    var normalized=(value.length>1&&value[1]===':')||value.indexOf('\\\\\\\\')===0
      ? value.replace(/\\\\/g,'/')
      : value;
    if(normalized==='/')return normalized;
    return normalized.replace(/\\/+$/,'');
  }

  try{
    var match=/^\\/([^/]+)\\/session\\/?$/.exec(window.location.pathname);
    if(!match)return;
    var directory=decodeRouteSegment(match[1]);
    if(!directory)return;

    var storageKey=${JSON.stringify(OPENCODE_SERVER_STATE_KEY)};
    var raw=window.localStorage.getItem(storageKey);
    var state={};
    if(raw){
      try{
        var parsed=JSON.parse(raw);
        if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))state=parsed;
      }catch(e){}
    }

    if(!state.projects||typeof state.projects!=='object'||Array.isArray(state.projects)){
      state.projects={};
    }
    var projects=Array.isArray(state.projects.local)?state.projects.local:[];
    var key=pathKey(directory);
    var exists=projects.some(function(project){
      return project&&typeof project.worktree==='string'&&pathKey(project.worktree)===key;
    });
    if(!exists){
      state.projects.local=[{worktree:directory,expanded:true}].concat(projects);
    }else{
      state.projects.local=projects;
    }

    if(!state.lastProject||typeof state.lastProject!=='object'||Array.isArray(state.lastProject)){
      state.lastProject={};
    }
    state.lastProject.local=directory;

    if(state.recentlyClosed&&typeof state.recentlyClosed==='object'&&!Array.isArray(state.recentlyClosed)){
      var closed=state.recentlyClosed.local;
      if(Array.isArray(closed)){
        state.recentlyClosed.local=closed.filter(function(worktree){
          return typeof worktree!=='string'||pathKey(worktree)!==key;
        });
      }
    }

    window.localStorage.setItem(storageKey,JSON.stringify(state));
  }catch(e){}
})();
</script>`;
